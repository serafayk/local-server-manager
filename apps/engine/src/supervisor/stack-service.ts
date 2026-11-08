import type {
  BulkProjectResult,
  DependencyWait,
  ProjectConfig,
  ProjectDependency,
  StackRunResult,
  StartReason,
} from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, isAppError } from '@lsm/shared';
import { runWithConcurrency } from '../core/concurrency';
import { isActiveStatus } from './project-runtime';
import type { Supervisor } from './supervisor';

const POLL_INTERVAL_MS = 250;
const ACTIVE_START_STATUSES = new Set(['STARTING', 'RUNNING', 'RESTARTING']);

/** Nó mínimo para ordenar dependências (testável sem banco). */
export interface DependencyGraphNode {
  id: string;
  name: string;
  startupOrder: number;
  dependsOn: readonly ProjectDependency[];
}

/**
 * Ordena em níveis: tudo dentro de um nível pode subir em paralelo.
 * Dependências fora de `restrictTo` são ignoradas (parada de grupo não deve
 * parar projetos externos). Ciclo vira erro explícito.
 */
export function orderByDependencies(
  nodes: Iterable<DependencyGraphNode>,
  restrictTo?: ReadonlySet<string>,
): string[][] {
  const byId = new Map<string, DependencyGraphNode>();
  for (const node of nodes) {
    if (!restrictTo || restrictTo.has(node.id)) {
      byId.set(node.id, node);
    }
  }

  const done = new Set<string>();
  const levels: string[][] = [];

  while (byId.size > 0) {
    const level = [...byId.values()]
      .filter((node) =>
        node.dependsOn.every(
          (dependency) => !byId.has(dependency.projectId) || done.has(dependency.projectId),
        ),
      )
      .sort((a, b) => {
        const byOrder = a.startupOrder - b.startupOrder;
        return byOrder !== 0 ? byOrder : a.name.localeCompare(b.name);
      })
      .map((node) => node.id);

    if (level.length === 0) {
      const names = [...byId.values()].map((node) => node.name).join(', ');
      throw new AppError(
        'DEPENDENCY_CYCLE',
        `Dependências formam um ciclo entre: ${names}. Ajuste "Depende de" para eliminar o ciclo.`,
      );
    }
    for (const id of level) {
      done.add(id);
      byId.delete(id);
    }
    levels.push(level);
  }

  return levels;
}

/** Fecha o conjunto com todas as dependências transitivas (inclui a raiz). */
export function collectDependencies<T extends DependencyGraphNode>(
  rootIds: readonly string[],
  all: ReadonlyMap<string, T>,
): Map<string, T> {
  const selected = new Map<string, T>();
  const pending = [...rootIds];

  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || selected.has(id)) {
      continue;
    }
    const node = all.get(id);
    if (!node) {
      throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${id}`);
    }
    selected.set(id, node);
    for (const dependency of node.dependsOn) {
      if (!all.has(dependency.projectId)) {
        throw new AppError(
          'DEPENDENCY_MISSING',
          `O projeto "${node.name}" depende de um projeto que não existe mais (${dependency.projectId}).`,
        );
      }
      pending.push(dependency.projectId);
    }
  }

  return selected;
}

export interface StackServiceDeps {
  repositories: Repositories;
  supervisor: Supervisor;
  clock: Clock;
  logger: Logger;
  batchConcurrency?: number;
}

/**
 * Orquestração de dependências: sobe na ordem topológica, aguarda readiness e
 * propaga falhas. O Supervisor continua sendo a única autoridade sobre processos.
 */
export class StackService {
  private batchConcurrency: number;

  constructor(private readonly deps: StackServiceDeps) {
    this.batchConcurrency = Math.max(1, Math.min(32, deps.batchConcurrency ?? 4));
  }

  setBatchConcurrency(value: number): void {
    this.batchConcurrency = Math.max(1, Math.min(32, Math.floor(value)));
  }

  /** Sobe o projeto e toda a cadeia de dependências que ainda não estiver ativa. */
  async startProjectWithDependencies(
    projectIdOrName: string,
    reason: StartReason = 'USER',
  ): Promise<StackRunResult> {
    const root = this.requireProject(projectIdOrName);
    return this.startMany([root.id], reason);
  }

  /** Sobe um grupo inteiro (mais dependências externas) na ordem correta. */
  async startGroup(groupIdOrName: string, reason: StartReason = 'USER'): Promise<StackRunResult> {
    const ids = this.groupProjectIds(groupIdOrName);
    return this.startMany(ids, reason);
  }

  /**
   * Projetos marcados para boot, em ordem topológica. Dependências não marcadas
   * para boot também sobem; projetos bloqueados por órfão não são tocados.
   */
  async startBootProjects(excludedProjectIds?: ReadonlySet<string>): Promise<BulkProjectResult[]> {
    const bootProjects = this.deps.repositories.projects
      .listBootProjects()
      .filter((project) => !excludedProjectIds?.has(project.id));
    if (bootProjects.length === 0) {
      return [];
    }
    const run = await this.startMany(
      bootProjects.map((project) => project.id),
      'BOOT',
      excludedProjectIds,
    );
    return run.results;
  }

  async restartGroup(groupIdOrName: string): Promise<StackRunResult> {
    const ids = this.groupProjectIds(groupIdOrName);
    await this.stopMany(ids, 'RESTART_MANUAL');
    return this.startMany(ids, 'RESTART');
  }

  async startProjects(
    projectIds: readonly string[],
    reason: StartReason = 'USER',
  ): Promise<StackRunResult> {
    return this.startMany(projectIds, reason);
  }

  /** Para em ordem inversa: dependentes antes das dependências. */
  async stopGroup(groupIdOrName: string): Promise<StackRunResult & { levels: string[][] }> {
    return this.stopMany(this.groupProjectIds(groupIdOrName), 'STOP_MANUAL');
  }

  async stopProjects(
    projectIds: readonly string[],
  ): Promise<StackRunResult & { levels: string[][] }> {
    return this.stopMany(projectIds, 'STOP_MANUAL');
  }

  private async startMany(
    projectIds: readonly string[],
    reason: StartReason,
    blocked?: ReadonlySet<string>,
  ): Promise<StackRunResult> {
    const all = new Map(
      this.deps.repositories.projects.list().map((project) => [project.id, project]),
    );
    const selected = collectDependencies(projectIds, all);
    const levels = orderByDependencies(selected.values());

    const results: BulkProjectResult[] = [];
    const skipped: Array<{ projectId: string; reason: string }> = [];
    const failed = new Set<string>();

    this.deps.logger.info('Stack start', {
      roots: projectIds,
      projects: selected.size,
      levels: levels.length,
    });

    for (const level of levels) {
      const runnable: ProjectConfig[] = [];
      for (const id of level) {
        const config = selected.get(id) as ProjectConfig;
        if (blocked?.has(id)) {
          const blockedReason =
            'bloqueado por instância órfã detectada no boot; verifique o processo manualmente';
          failed.add(id);
          skipped.push({ projectId: id, reason: blockedReason });
          results.push({
            projectId: id,
            success: false,
            errorCode: 'PROJECT_START_FAILED',
            message: blockedReason,
          });
          continue;
        }
        const blockedBy = config.dependsOn.find((dependency) => failed.has(dependency.projectId));
        if (blockedBy) {
          const dependency = selected.get(blockedBy.projectId);
          const reason = `dependência "${dependency?.name ?? blockedBy.projectId}" falhou`;
          failed.add(id);
          skipped.push({ projectId: id, reason });
          results.push({
            projectId: id,
            success: false,
            errorCode: 'DEPENDENCY_FAILED',
            message: reason,
          });
          continue;
        }
        runnable.push(config);
      }

      await runWithConcurrency(
        runnable,
        Math.max(1, Math.min(this.batchConcurrency, runnable.length)),
        async (config) => {
          try {
            if (!config.enabled) {
              throw new AppError(
                'PROJECT_DISABLED',
                `O projeto "${config.name}" está desabilitado e não pode ser iniciado.`,
              );
            }
            // Dependências estão em níveis anteriores; só libera depois do critério.
            await this.awaitDependencyReadiness(config);
            await this.ensureRunning(config.id, reason);
            results.push({ projectId: config.id, success: true });
          } catch (error) {
            failed.add(config.id);
            results.push(toBulkFailure(config.id, error));
            this.deps.logger.warn(
              'Falha ao iniciar projeto da stack',
              { projectId: config.id, name: config.name },
              error,
            );
          }
        },
      );
    }

    const success = results.every((result) => result.success);
    this.deps.repositories.events.append({
      projectId: null,
      instanceId: null,
      level: success ? 'info' : 'warn',
      eventType: 'stack.start.completed',
      message: success
        ? `stack iniciada (${results.length} projeto(s))`
        : `stack iniciada com falhas (${results.filter((item) => !item.success).length} de ${results.length})`,
      metadata: { roots: projectIds, levels, skipped },
    });

    return { levels, results, skipped };
  }

  private async stopMany(
    projectIds: readonly string[],
    reason: 'STOP_MANUAL' | 'RESTART_MANUAL',
  ): Promise<StackRunResult & { levels: string[][] }> {
    const all = new Map(
      this.deps.repositories.projects.list().map((project) => [project.id, project]),
    );
    const restrict = new Set(projectIds);
    const levels = orderByDependencies(
      [...restrict].map((id) => {
        const project = all.get(id);
        if (!project) {
          throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${id}`);
        }
        return project;
      }),
      restrict,
    ).reverse();

    const results: BulkProjectResult[] = [];
    for (const level of levels) {
      await runWithConcurrency(level, Math.max(1, level.length), async (projectId) => {
        try {
          const snapshot = this.deps.supervisor.getSnapshotById(projectId);
          if (!snapshot || !isActiveStatus(snapshot.status)) {
            results.push({ projectId, success: true });
            return;
          }
          await this.deps.supervisor.stopProject(projectId, reason);
          results.push({ projectId, success: true });
        } catch (error) {
          // Stop é idempotente na stack: projeto já parado não é falha.
          if (isAppError(error) && error.code === 'PROJECT_NOT_RUNNING') {
            results.push({ projectId, success: true });
            return;
          }
          results.push(toBulkFailure(projectId, error));
        }
      });
    }

    return { levels, results, skipped: [] };
  }

  /** Chama o start quando necessário e espera o processo ficar RUNNING. */
  private async ensureRunning(projectId: string, reason: StartReason): Promise<void> {
    const snapshot = this.deps.supervisor.getSnapshotById(projectId);
    if (snapshot && snapshot.status === 'RUNNING') {
      return;
    }
    if (snapshot && ACTIVE_START_STATUSES.has(snapshot.status)) {
      await this.awaitStatus(projectId, ['RUNNING'], null);
      return;
    }
    await this.deps.supervisor.startProject(projectId, reason);
  }

  /**
   * Para cada dependência, espera o critério configurado na aresta
   * (`started` ou `ready`), com o timeout do projeto dependente.
   */
  private async awaitDependencyReadiness(config: ProjectConfig): Promise<void> {
    for (const dependency of config.dependsOn) {
      const dependencyConfig = this.deps.repositories.projects.findById(dependency.projectId);
      if (!dependencyConfig) {
        throw new AppError(
          'DEPENDENCY_MISSING',
          `O projeto "${config.name}" depende de um projeto que não existe mais.`,
        );
      }
      await this.awaitDependency(config, dependencyConfig, dependency.waitFor);
    }
  }

  private async awaitDependency(
    dependent: ProjectConfig,
    dependency: ProjectConfig,
    waitFor: DependencyWait,
  ): Promise<void> {
    const timeoutMs = dependent.dependencyTimeoutMs;
    const deadline = this.deps.clock.nowMs() + timeoutMs;
    const requiresHealth = waitFor === 'ready' && dependency.healthCheck.enabled;

    for (;;) {
      const snapshot = this.deps.supervisor.getSnapshotById(dependency.id);
      if (!snapshot) {
        throw new AppError(
          'DEPENDENCY_FAILED',
          `Dependência "${dependency.name}" não está registrada no Engine.`,
        );
      }

      if (snapshot.status === 'FAILED') {
        throw new AppError(
          'DEPENDENCY_FAILED',
          `Dependência "${dependency.name}" falhou ao iniciar` +
            (snapshot.lastFailureHint ? `: ${snapshot.lastFailureHint}` : '.'),
        );
      }

      const running = snapshot.status === 'RUNNING';
      if (running && !requiresHealth) {
        return;
      }
      if (running && requiresHealth && snapshot.health === 'HEALTHY') {
        return;
      }

      if (this.deps.clock.nowMs() >= deadline) {
        throw new AppError(
          'DEPENDENCY_TIMEOUT',
          requiresHealth
            ? `"${dependency.name}" não ficou saudável em ${Math.round(timeoutMs / 1_000)}s; "${dependent.name}" não foi iniciado.`
            : `"${dependency.name}" não iniciou em ${Math.round(timeoutMs / 1_000)}s; "${dependent.name}" não foi iniciado.`,
        );
      }

      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  /** Espera o projeto sair de STARTING/RESTARTING (usado em start concorrente). */
  private async awaitStatus(
    projectId: string,
    expected: readonly string[],
    timeoutMs: number | null,
  ): Promise<void> {
    const deadline =
      timeoutMs === null ? Number.POSITIVE_INFINITY : this.deps.clock.nowMs() + timeoutMs;
    for (;;) {
      const snapshot = this.deps.supervisor.getSnapshotById(projectId);
      if (snapshot && expected.includes(snapshot.status)) {
        return;
      }
      if (snapshot?.status === 'FAILED' || this.deps.clock.nowMs() >= deadline) {
        throw new AppError(
          'PROJECT_START_FAILED',
          `Projeto ${projectId} não atingiu o estado ${expected.join('/')}`,
        );
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  private sleep(delayMs: number): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      const handle = this.deps.clock.setTimeout(() => resolvePromise(), delayMs);
      handle.unref();
    });
  }

  private groupProjectIds(groupIdOrName: string): string[] {
    const group =
      this.deps.repositories.groups.findById(groupIdOrName) ??
      this.deps.repositories.groups.findByName(groupIdOrName);
    if (!group) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${groupIdOrName}`);
    }
    const ids = this.deps.repositories.projects
      .list()
      .filter((project) => project.groupId === group.id)
      .map((project) => project.id);
    if (ids.length === 0) {
      throw new AppError('GROUP_EMPTY', `O grupo "${group.name}" não tem projetos.`);
    }
    return ids;
  }

  private requireProject(projectIdOrName: string): ProjectConfig {
    const project =
      this.deps.repositories.projects.findById(projectIdOrName) ??
      this.deps.repositories.projects.findByName(projectIdOrName);
    if (!project) {
      throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${projectIdOrName}`);
    }
    return project;
  }
}

function toBulkFailure(projectId: string, error: unknown): BulkProjectResult {
  if (isAppError(error)) {
    return { projectId, success: false, errorCode: error.code, message: error.message };
  }
  return {
    projectId,
    success: false,
    errorCode: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
