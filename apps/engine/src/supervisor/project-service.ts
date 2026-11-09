import { mkdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ListEventsOptions, SystemEvent } from '@lsm/database';
import type {
  BuildResult,
  ExportBundle,
  ExportedProject,
  ImportConfigResponse,
  ImportConfigResult,
  LaunchPreview,
  LogRecord,
  PostgresBackupResult,
  PostgresConnectionInfo,
  ProjectConfig,
  ProjectDependency,
  ProjectSummary,
} from '@lsm/contracts';
import { CURRENT_CONFIG_SCHEMA_VERSION } from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, isAppError, newId } from '@lsm/shared';
import {
  parseCreateProjectRequest,
  parseExportBundle,
  parseUpdateProjectRequest,
} from '@lsm/validation';
import type { EventBus } from '../core/event-bus';
import type { LogManager } from '../log-manager/log-manager';
import { resolveBuildCommand, resolveLaunch } from '../launch/launch-resolver';
import {
  pgDumpSpec,
  postgresConnectionUrl,
  resolvePostgresConfig,
} from '../postgres/command-builder';
import { postgresServiceName, removePostgresService } from '../postgres/service-manager';
import type { ProcessManager } from '../process-manager/process-manager';
import type { ManagedProcess } from '../process-manager/spawn-adapter';
import type { GroupService } from './group-service';
import { isActiveStatus } from './project-runtime';
import { orderByDependencies } from './stack-service';
import type { Supervisor } from './supervisor';

const SENSITIVE_ENV_KEY =
  /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|session)/i;

const BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const BACKUP_TIMEOUT_MS = 10 * 60 * 1_000;

export interface ProjectServiceDeps {
  repositories: Repositories;
  supervisor: Supervisor;
  groups: GroupService;
  logManager: LogManager;
  processManager: ProcessManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  postgresRoot: string;
  postgresBackupsDir: string;
}

export interface TailLogsResult {
  instanceId: string | null;
  records: LogRecord[];
}

/**
 * Cadastro de projetos (CRUD de configuração). O ciclo de vida continua sendo
 * responsabilidade exclusiva do Supervisor.
 */
export class ProjectService {
  private readonly building = new Set<string>();

  constructor(private readonly deps: ProjectServiceDeps) {}

  createProject(input: unknown): ProjectConfig {
    const fields = parseCreateProjectRequest(input);
    if (fields.groupId !== null && !this.deps.repositories.groups.findById(fields.groupId)) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${fields.groupId}`);
    }
    const now = this.deps.clock.nowIso();
    const config: ProjectConfig = {
      id: newId(),
      ...fields,
      postgres:
        fields.postgres !== null && fields.postgres.password.trim() === ''
          ? { ...fields.postgres, password: generatePassword() }
          : fields.postgres,
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };

    this.assertDependencies(config);
    this.deps.repositories.projects.create(config);
    try {
      this.deps.supervisor.registerProject(config);
    } catch (error) {
      // Mantém banco e memória consistentes se o registro falhar.
      this.deps.repositories.projects.delete(config.id);
      throw error;
    }

    this.deps.repositories.events.append({
      projectId: config.id,
      instanceId: null,
      level: 'info',
      eventType: 'project.created',
      message: `projeto "${config.name}" cadastrado`,
      metadata: {
        name: config.name,
        workingDirectory: config.workingDirectory,
        executable: config.runtime.executable,
        args: config.runtime.args,
      },
    });
    this.deps.events.emit(
      'project.created',
      { projectId: config.id, name: config.name },
      config.id,
    );
    this.deps.logger.info('Projeto cadastrado', { projectId: config.id, name: config.name });
    return config;
  }

  updateProject(projectIdOrName: string, input: unknown): ProjectConfig {
    const existing = this.getProject(projectIdOrName);
    const snapshot = this.deps.supervisor.getSnapshotById(existing.id);
    if (snapshot && isActiveStatus(snapshot.status)) {
      throw new AppError(
        'ENGINE_BUSY',
        `Pare o projeto "${existing.name}" antes de editar a configuração.`,
      );
    }

    const config = parseUpdateProjectRequest(existing, input, this.deps.clock.nowIso());
    if (config.postgres !== null && config.postgres.password.trim() === '') {
      config.postgres = { ...config.postgres, password: generatePassword() };
    }

    if (config.groupId !== null && !this.deps.repositories.groups.findById(config.groupId)) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${config.groupId}`);
    }

    this.assertDependencies(config);
    this.deps.repositories.projects.update(config);
    this.deps.supervisor.registerProject(config);

    this.deps.repositories.events.append({
      projectId: config.id,
      instanceId: null,
      level: 'info',
      eventType: 'project.updated',
      message: `projeto "${config.name}" atualizado`,
      metadata: { name: config.name },
    });
    this.deps.events.emit(
      'project.updated',
      { projectId: config.id, name: config.name },
      config.id,
    );
    this.deps.logger.info('Projeto atualizado', { projectId: config.id, name: config.name });
    return config;
  }

  deleteProject(
    projectIdOrName: string,
    options: { force?: boolean } = {},
  ): { id: string; name: string } {
    const config = this.getProject(projectIdOrName);
    const snapshot = this.deps.supervisor.getSnapshotById(config.id);
    if (snapshot && isActiveStatus(snapshot.status)) {
      throw new AppError(
        'PROJECT_ALREADY_RUNNING',
        `Pare o projeto "${config.name}" antes de remover o cadastro.`,
      );
    }

    const dependents = this.deps.repositories.projects
      .list()
      .filter(
        (project) =>
          project.id !== config.id &&
          project.dependsOn.some((dependency) => dependency.projectId === config.id),
      );
    if (dependents.length > 0 && options.force !== true) {
      throw new AppError(
        'PROJECT_HAS_DEPENDENTS',
        `"${config.name}" é dependência de ${dependents
          .map((project) => `"${project.name}"`)
          .join(', ')}. Remova com force para desvincular.`,
      );
    }

    this.deps.repositories.projects.delete(config.id);
    this.deps.supervisor.unregisterProject(config.id);

    if (config.kind === 'postgres') {
      void removePostgresService(postgresServiceName(config.id)).catch((error: unknown) => {
        this.deps.logger.warn(
          'Falha ao remover serviço do PostgreSQL',
          { projectId: config.id },
          error,
        );
      });
    }

    // Remove referências pendentes para não deixar dependências órfãs.
    for (const dependent of dependents) {
      const updated: ProjectConfig = {
        ...dependent,
        dependsOn: dependent.dependsOn.filter((dependency) => dependency.projectId !== config.id),
        updatedAt: this.deps.clock.nowIso(),
      };
      this.deps.repositories.projects.update(updated);
      this.deps.supervisor.registerProject(updated);
    }

    this.deps.repositories.events.append({
      projectId: config.id,
      instanceId: null,
      level: 'warn',
      eventType: 'project.deleted',
      message: `projeto "${config.name}" removido do cadastro`,
      metadata: {
        projectId: config.id,
        name: config.name,
        unlinkedDependents: dependents.map((project) => project.name),
      },
    });
    this.deps.events.emit(
      'project.deleted',
      { projectId: config.id, name: config.name },
      config.id,
    );
    this.deps.logger.info('Projeto removido', { projectId: config.id, name: config.name });
    return { id: config.id, name: config.name };
  }

  /** Dependência inexistente, auto-dependência ou ciclo são erros de configuração. */
  private assertDependencies(candidate: ProjectConfig): void {
    const byId = new Map(
      this.deps.repositories.projects.list().map((project) => [project.id, project]),
    );
    byId.set(candidate.id, candidate);

    for (const dependency of candidate.dependsOn) {
      if (dependency.projectId === candidate.id) {
        throw new AppError(
          'DEPENDENCY_CYCLE',
          `"${candidate.name}" não pode depender de si mesmo.`,
        );
      }
      if (!byId.has(dependency.projectId)) {
        throw new AppError(
          'DEPENDENCY_MISSING',
          `Dependência não encontrada: ${dependency.projectId}. Cadastre o projeto antes de referenciá-lo.`,
        );
      }
    }

    orderByDependencies(
      [...byId.values()].map((project) => ({
        id: project.id,
        name: project.name,
        startupOrder: project.startupOrder,
        dependsOn: project.dependsOn,
      })),
    );
  }

  getProject(projectIdOrName: string): ProjectConfig {
    const byId = this.deps.repositories.projects.findById(projectIdOrName);
    const config = byId ?? this.deps.repositories.projects.findByName(projectIdOrName);
    if (!config) {
      throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${projectIdOrName}`);
    }
    return config;
  }

  listProjects(): ProjectSummary[] {
    const summaries = new Map<string, ProjectSummary>();
    for (const summary of this.deps.supervisor.listSummaries()) {
      summaries.set(summary.config.id, summary);
    }
    return [...summaries.values()];
  }

  listEvents(options: ListEventsOptions = {}): SystemEvent[] {
    return this.deps.repositories.events.list(options);
  }

  /** Prévia do comando que o Engine usaria, sem iniciar nada. */
  launchPreview(projectIdOrName: string): LaunchPreview {
    const config = this.getProject(projectIdOrName);
    const launch = resolveLaunch(config);
    return {
      mode: launch.mode,
      executable: launch.executable,
      args: launch.args,
      cwd: launch.cwd,
      reason: launch.reason,
      skippedProcesses: launch.skippedProcesses,
      script: launch.script,
      appDirectory: launch.appDirectory,
    };
  }

  /** Executa o script `build` uma única vez, com logs e timeout. */
  async buildProject(projectIdOrName: string): Promise<BuildResult> {
    const config = this.getProject(projectIdOrName);
    const snapshot = this.deps.supervisor.getSnapshot(config.id);
    if (isActiveStatus(snapshot.status)) {
      throw new AppError(
        'PROJECT_ALREADY_RUNNING',
        `Pare o projeto "${config.name}" antes de rodar o build`,
      );
    }
    if (this.building.has(config.id)) {
      throw new AppError('PROJECT_ALREADY_RUNNING', 'Já existe um build em andamento');
    }

    const command = resolveBuildCommand(config);
    if (command === null) {
      throw new AppError(
        'PROJECT_INVALID_CONFIG',
        `Script "build" não encontrado para "${config.name}"`,
      );
    }

    this.building.add(config.id);
    const instanceId = newId();
    const startedAt = Date.now();
    this.deps.logManager.registerStream(config.id, instanceId, config.logging, 'project.log');
    this.deps.logManager.recordSystem(
      config.id,
      instanceId,
      `build iniciado (${command.executable} ${command.args.join(' ')})`,
    );

    try {
      const managed = this.deps.processManager.spawn({
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        env: { ...config.environment },
      });
      managed.onStdout((chunk) =>
        this.deps.logManager.push(config.id, instanceId, 'stdout', chunk),
      );
      managed.onStderr((chunk) =>
        this.deps.logManager.push(config.id, instanceId, 'stderr', chunk),
      );

      const exitCode = await waitForBuildExit(managed, BUILD_TIMEOUT_MS, () =>
        this.deps.processManager.stop(managed.pid, { gracefulTimeoutMs: 5_000 }),
      );
      const durationMs = Date.now() - startedAt;
      const success = exitCode === 0;
      this.deps.logManager.recordSystem(
        config.id,
        instanceId,
        `build ${success ? 'concluído' : 'falhou'} (code=${exitCode ?? 'null'}, ${Math.round(durationMs / 1_000)}s)`,
      );
      return { success, exitCode, durationMs, instanceId };
    } finally {
      this.building.delete(config.id);
      await this.deps.logManager.closeInstance(instanceId).catch(() => undefined);
    }
  }

  /** Conexão do Postgres dedicado (porta/data dir resolvidos). */
  postgresInfo(projectIdOrName: string): PostgresConnectionInfo {
    const config = this.getProject(projectIdOrName);
    if (config.kind !== 'postgres') {
      throw new AppError('PROJECT_INVALID_CONFIG', `O projeto "${config.name}" não é PostgreSQL`);
    }
    const resolved = resolvePostgresConfig(config, this.deps.postgresRoot);
    const snapshot = this.deps.supervisor.getSnapshot(config.id);
    return {
      host: '127.0.0.1',
      port: resolved.port,
      username: resolved.username,
      database: 'postgres',
      dataDir: resolved.dataDir,
      binDir: resolved.binDir,
      version: resolved.version,
      url: postgresConnectionUrl(resolved),
      running: snapshot.status === 'RUNNING',
    };
  }

  /** `pg_dump` do banco padrão do serviço (exige o projeto em execução). */
  async backupPostgres(projectIdOrName: string): Promise<PostgresBackupResult> {
    const config = this.getProject(projectIdOrName);
    if (config.kind !== 'postgres' || config.postgres === null) {
      throw new AppError('PROJECT_INVALID_CONFIG', `O projeto "${config.name}" não é PostgreSQL`);
    }
    const snapshot = this.deps.supervisor.getSnapshot(config.id);
    if (snapshot.status !== 'RUNNING') {
      throw new AppError('PROJECT_NOT_RUNNING', `Inicie "${config.name}" antes de gerar o backup`);
    }

    const resolved = resolvePostgresConfig(config, this.deps.postgresRoot);
    mkdirSync(this.deps.postgresBackupsDir, { recursive: true });
    const stamp = this.deps.clock.nowIso().replace(/[:.]/g, '-');
    const file = join(this.deps.postgresBackupsDir, `${slugify(config.name)}-${stamp}.dump`);
    const instanceId = newId();
    const startedAt = Date.now();
    const spec = pgDumpSpec(resolved, file);

    this.deps.logManager.registerStream(config.id, instanceId, config.logging, 'project.log');
    this.deps.logManager.recordSystem(
      config.id,
      instanceId,
      `pg_dump iniciado (porta ${resolved.port}, usuário ${resolved.username})`,
    );

    try {
      const managed = this.deps.processManager.spawn({
        executable: spec.executable,
        args: spec.args,
        cwd: resolved.binDir,
        env: { ...config.environment, ...spec.env },
      });
      managed.onStdout((chunk) =>
        this.deps.logManager.push(config.id, instanceId, 'stdout', chunk),
      );
      managed.onStderr((chunk) =>
        this.deps.logManager.push(config.id, instanceId, 'stderr', chunk),
      );

      const exitCode = await waitForBuildExit(managed, BACKUP_TIMEOUT_MS, () =>
        this.deps.processManager.stop(managed.pid, { gracefulTimeoutMs: 5_000 }),
      );
      const durationMs = Date.now() - startedAt;
      if (exitCode !== 0) {
        throw new AppError(
          'BACKUP_FAILED',
          `pg_dump falhou (code ${String(exitCode)}). Veja os logs do projeto.`,
        );
      }
      const sizeBytes = statSync(file).size;
      this.deps.logManager.recordSystem(
        config.id,
        instanceId,
        `backup concluído (${Math.round(sizeBytes / 1024)} KB, ${Math.round(durationMs / 1_000)}s)`,
      );
      this.deps.repositories.events.append({
        projectId: config.id,
        instanceId,
        level: 'info',
        eventType: 'postgres.backup.completed',
        message: `backup do PostgreSQL gerado`,
        metadata: { file, sizeBytes },
      });
      return { file, sizeBytes, durationMs };
    } finally {
      await this.deps.logManager.closeInstance(instanceId).catch(() => undefined);
    }
  }

  /** Exporta configurações sem segredos de ambiente. */
  exportConfiguration(): ExportBundle {
    const groupNames = new Map(
      this.deps.repositories.groups.list().map((group) => [group.id, group.name]),
    );
    const allProjects = this.deps.repositories.projects.list();
    const projectNames = new Map(allProjects.map((project) => [project.id, project.name]));

    const projects: ExportedProject[] = allProjects.map((config) => {
      const environment: Record<string, string> = {};
      const maskedEnvironmentKeys: string[] = [];
      for (const [key, value] of Object.entries(config.environment)) {
        if (SENSITIVE_ENV_KEY.test(key)) {
          maskedEnvironmentKeys.push(key);
        } else {
          environment[key] = value;
        }
      }

      return {
        name: config.name,
        description: config.description,
        group: config.groupId ? (groupNames.get(config.groupId) ?? null) : null,
        workingDirectory: config.workingDirectory,
        runtime: config.runtime,
        environment,
        maskedEnvironmentKeys,
        port: config.port,
        portSource: config.portSource,
        launchMode: config.launchMode,
        serveMode: config.serveMode,
        outputDir: config.outputDir,
        kind: config.kind,
        compose: config.compose,
        postgres: config.postgres === null ? null : { ...config.postgres, password: '' },
        dependsOn: config.dependsOn.flatMap((dependency) => {
          const name = projectNames.get(dependency.projectId);
          return name ? [{ project: name, waitFor: dependency.waitFor }] : [];
        }),
        dependencyTimeoutMs: config.dependencyTimeoutMs,
        enabled: config.enabled,
        startOnBoot: config.startOnBoot,
        startupOrder: config.startupOrder,
        restartPolicy: config.restartPolicy,
        healthCheck: config.healthCheck,
        logging: config.logging,
        shutdown: config.shutdown,
      };
    });

    return {
      schemaVersion: 1,
      exportedAt: this.deps.clock.nowIso(),
      projects,
    };
  }

  /** Importa um bundle exportado; uma falha não cancela os demais. */
  importConfiguration(input: unknown): ImportConfigResponse {
    const bundle = parseExportBundle(input);
    const results: ImportConfigResult[] = [];
    const created = new Map<string, string>();

    for (const item of bundle.projects) {
      try {
        const groupId = item.group ? this.deps.groups.ensureByName(item.group).id : null;
        const config = this.createProject({
          name: item.name,
          description: item.description ?? null,
          groupId,
          workingDirectory: item.workingDirectory,
          runtime: item.runtime,
          environment: item.environment ?? {},
          // Dependências são vinculadas depois que todos existirem (referências por nome).
          dependsOn: [],
          dependencyTimeoutMs: item.dependencyTimeoutMs ?? 60_000,
          port: item.port ?? null,
          portSource:
            item.portSource ?? (item.port !== null && item.port !== undefined ? 'fixed' : 'none'),
          launchMode: item.launchMode ?? 'auto',
          serveMode: item.serveMode ?? 'process',
          outputDir: item.outputDir ?? null,
          kind: item.kind ?? 'node',
          compose: item.compose ?? null,
          postgres: item.postgres ?? null,
          enabled: item.enabled ?? true,
          startOnBoot: item.startOnBoot ?? false,
          startupOrder: item.startupOrder ?? 0,
          ...(item.restartPolicy !== undefined ? { restartPolicy: item.restartPolicy } : {}),
          ...(item.healthCheck !== undefined ? { healthCheck: item.healthCheck } : {}),
          ...(item.logging !== undefined ? { logging: item.logging } : {}),
          ...(item.shutdown !== undefined ? { shutdown: item.shutdown } : {}),
        });
        created.set(item.name, config.id);
        results.push({
          name: item.name,
          success: true,
          ...(config.kind === 'postgres'
            ? { message: 'senha do PostgreSQL gerada novamente (segredos não são exportados)' }
            : {}),
        });
      } catch (error) {
        results.push(
          isAppError(error)
            ? {
                name: item.name,
                success: false,
                errorCode: error.code,
                message: error.message,
              }
            : {
                name: item.name,
                success: false,
                errorCode: 'INTERNAL_ERROR',
                message: error instanceof Error ? error.message : String(error),
              },
        );
      }
    }

    // Segunda passada: resolve dependências por nome (IDs não são portáveis).
    for (const item of bundle.projects) {
      if (!item.dependsOn || item.dependsOn.length === 0) {
        continue;
      }
      const projectId = created.get(item.name);
      const result = results.find((entry) => entry.name === item.name && entry.success);
      if (!projectId || !result) {
        continue;
      }

      const resolved: ProjectDependency[] = [];
      const missing: string[] = [];
      for (const dependency of item.dependsOn) {
        const targetId =
          created.get(dependency.project) ??
          this.deps.repositories.projects.findByName(dependency.project)?.id;
        if (!targetId) {
          missing.push(dependency.project);
          continue;
        }
        resolved.push({ projectId: targetId, waitFor: dependency.waitFor });
      }

      try {
        if (resolved.length > 0) {
          this.updateProject(projectId, { dependsOn: resolved });
        }
      } catch (error) {
        result.success = false;
        result.errorCode = isAppError(error) ? error.code : 'INTERNAL_ERROR';
        result.message = error instanceof Error ? error.message : String(error);
        continue;
      }

      if (missing.length > 0) {
        result.message = `dependências ignoradas (não encontradas): ${missing.join(', ')}`;
      }
    }

    return { results };
  }

  tailLogs(projectIdOrName: string, limit = 50, instanceId?: string): TailLogsResult {
    const config = this.getProject(projectIdOrName);
    if (instanceId !== undefined) {
      // Evita traversal: instanceId vira nome de arquivo no LogManager.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) {
        throw new AppError('VALIDATION_ERROR', `instanceId inválido: ${instanceId}`);
      }
      return {
        instanceId,
        records: this.deps.logManager.tail(config.id, instanceId, limit),
      };
    }
    const latest = this.deps.repositories.instances.listByProject(config.id, 1)[0];
    if (!latest) {
      return { instanceId: null, records: [] };
    }
    return {
      instanceId: latest.id,
      records: this.deps.logManager.tail(config.id, latest.id, limit),
    };
  }
}

/** Espera o fim de um processo one-shot (build/pg_dump) com timeout. */
function waitForBuildExit(
  managed: ManagedProcess,
  timeoutMs: number,
  onTimeout: () => Promise<unknown>,
): Promise<number | null> {
  return new Promise<number | null>((resolvePromise) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise(code);
    };
    managed.onExit((info) => finish(info.code));
    managed.onError(() => finish(null));
    const timer = setTimeout(() => {
      void onTimeout()
        .catch(() => undefined)
        .finally(() => finish(null));
    }, timeoutMs);
    timer.unref();
  });
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? 'postgres' : slug;
}
