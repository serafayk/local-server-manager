import type {
  BulkProjectResult,
  ProjectConfig,
  ProjectSummary,
  RuntimeSnapshot,
  StartReason,
  TerminationReason,
} from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, isAppError } from '@lsm/shared';
import type { EventBus } from '../core/event-bus';
import { runWithConcurrency } from '../core/concurrency';
import type { LogManager } from '../log-manager/log-manager';
import type { ProcessManager } from '../process-manager/process-manager';
import type { StaticHostManager } from '../static/static-host';
import { isActiveStatus, ProjectRuntime } from './project-runtime';
import { RuntimeRegistry } from './runtime-registry';

export interface SupervisorDeps {
  repositories: Repositories;
  logManager: LogManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  processManager: ProcessManager;
  staticHost: StaticHostManager;
  postgresRoot: string;
  batchConcurrency: number;
}

/**
 * Autoridade sobre processos em execução. Rotas/CLI nunca manipulam
 * ChildProcess: sempre passam por aqui (docs/03-ENGINE.md §3).
 */
export class Supervisor {
  private readonly registry = new RuntimeRegistry();
  private batchConcurrency: number;

  constructor(private readonly deps: SupervisorDeps) {
    this.batchConcurrency = deps.batchConcurrency;
  }

  setBatchConcurrency(value: number): void {
    this.batchConcurrency = Math.max(1, Math.min(32, Math.floor(value)));
  }

  registerProject(config: ProjectConfig): void {
    const existing = this.registry.get(config.id);
    if (existing) {
      existing.setConfig(config);
      return;
    }
    this.registry.add(
      new ProjectRuntime({
        config,
        repositories: this.deps.repositories,
        logManager: this.deps.logManager,
        events: this.deps.events,
        clock: this.deps.clock,
        logger: this.deps.logger,
        processManager: this.deps.processManager,
        staticHost: this.deps.staticHost,
        postgresRoot: this.deps.postgresRoot,
      }),
    );
  }

  unregisterProject(projectId: string): void {
    const runtime = this.registry.get(projectId);
    if (!runtime) {
      return;
    }
    if (isActiveStatus(runtime.status)) {
      throw new AppError(
        'PROJECT_ALREADY_RUNNING',
        'Não é possível remover um projeto em execução. Pare-o primeiro.',
      );
    }
    this.registry.remove(projectId);
  }

  listProjects(): ProjectConfig[] {
    return this.registry.list().map((runtime) => runtime.config);
  }

  listSummaries(): ProjectSummary[] {
    return this.registry
      .list()
      .sort((a, b) => {
        const byOrder = a.config.startupOrder - b.config.startupOrder;
        return byOrder !== 0 ? byOrder : a.config.name.localeCompare(b.config.name);
      })
      .map((runtime) => ({ config: runtime.config, runtime: runtime.snapshot() }));
  }

  getSnapshot(projectIdOrName: string): RuntimeSnapshot {
    return this.resolve(projectIdOrName).snapshot();
  }

  getSnapshotById(projectId: string): RuntimeSnapshot | null {
    return this.registry.get(projectId)?.snapshot() ?? null;
  }

  getConfig(projectIdOrName: string): ProjectConfig {
    return this.resolve(projectIdOrName).config;
  }

  async startProject(projectIdOrName: string, reason: StartReason = 'USER'): Promise<void> {
    await this.resolve(projectIdOrName).start(reason);
  }

  async stopProject(
    projectIdOrName: string,
    reason: TerminationReason = 'STOP_MANUAL',
  ): Promise<void> {
    await this.resolve(projectIdOrName).stop(reason);
  }

  async restartProject(projectIdOrName: string): Promise<void> {
    await this.resolve(projectIdOrName).restart();
  }

  async startProjects(
    projectIds: readonly string[],
    concurrency = this.batchConcurrency,
  ): Promise<BulkProjectResult[]> {
    return runWithConcurrency(projectIds, concurrency, async (projectId) => {
      try {
        await this.startProject(projectId, 'USER');
        return { projectId, success: true };
      } catch (error) {
        return toBulkFailure(projectId, error);
      }
    });
  }

  async stopProjects(
    projectIds: readonly string[],
    concurrency = this.batchConcurrency,
  ): Promise<BulkProjectResult[]> {
    return runWithConcurrency(projectIds, concurrency, async (projectId) => {
      try {
        await this.stopProject(projectId, 'STOP_MANUAL');
        return { projectId, success: true };
      } catch (error) {
        return toBulkFailure(projectId, error);
      }
    });
  }

  async startBootProjects(excludedProjectIds?: ReadonlySet<string>): Promise<BulkProjectResult[]> {
    const bootProjects = this.deps.repositories.projects
      .listBootProjects()
      .filter((project) => !excludedProjectIds?.has(project.id));
    const results = await runWithConcurrency(bootProjects, 1, async (project) => {
      try {
        await this.startProject(project.id, 'BOOT');
        return { projectId: project.id, success: true };
      } catch (error) {
        this.deps.logger.error(
          'Falha ao iniciar projeto marcado para boot',
          { projectId: project.id, name: project.name },
          error,
        );
        return toBulkFailure(project.id, error);
      }
    });
    return results;
  }

  /** ADR-008: encerramento explícito do Engine para todos os projetos. */
  async shutdown(): Promise<void> {
    const runtimes = this.registry.list();
    await runWithConcurrency(runtimes, this.batchConcurrency, async (runtime) => {
      await runtime.dispose();
    });
  }

  private resolve(projectIdOrName: string): ProjectRuntime {
    const direct = this.registry.get(projectIdOrName);
    if (direct) {
      return direct;
    }
    const config = this.deps.repositories.projects.findByName(projectIdOrName);
    const byName = config ? this.registry.get(config.id) : undefined;
    if (!byName) {
      throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${projectIdOrName}`);
    }
    return byName;
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
