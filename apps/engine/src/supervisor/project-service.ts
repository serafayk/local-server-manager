import type { ListEventsOptions, SystemEvent } from '@lsm/database';
import type {
  ExportBundle,
  ExportedProject,
  ImportConfigResponse,
  ImportConfigResult,
  LogRecord,
  ProjectConfig,
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
import type { GroupService } from './group-service';
import { isActiveStatus } from './project-runtime';
import type { Supervisor } from './supervisor';

const SENSITIVE_ENV_KEY =
  /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|session)/i;

export interface ProjectServiceDeps {
  repositories: Repositories;
  supervisor: Supervisor;
  groups: GroupService;
  logManager: LogManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
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
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };

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

    if (config.groupId !== null && !this.deps.repositories.groups.findById(config.groupId)) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${config.groupId}`);
    }

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

  deleteProject(projectIdOrName: string): { id: string; name: string } {
    const config = this.getProject(projectIdOrName);
    const snapshot = this.deps.supervisor.getSnapshotById(config.id);
    if (snapshot && isActiveStatus(snapshot.status)) {
      throw new AppError(
        'PROJECT_ALREADY_RUNNING',
        `Pare o projeto "${config.name}" antes de remover o cadastro.`,
      );
    }

    const removed = this.deps.repositories.projects.delete(config.id);
    if (!removed) {
      throw new AppError('PROJECT_NOT_FOUND', `Projeto não encontrado: ${config.id}`);
    }
    this.deps.supervisor.unregisterProject(config.id);

    this.deps.repositories.events.append({
      projectId: config.id,
      instanceId: null,
      level: 'warn',
      eventType: 'project.deleted',
      message: `projeto "${config.name}" removido do cadastro`,
      metadata: { projectId: config.id, name: config.name },
    });
    this.deps.events.emit(
      'project.deleted',
      { projectId: config.id, name: config.name },
      config.id,
    );
    this.deps.logger.info('Projeto removido', { projectId: config.id, name: config.name });
    return { id: config.id, name: config.name };
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

  /** Exporta configurações sem segredos de ambiente. */
  exportConfiguration(): ExportBundle {
    const groupNames = new Map(
      this.deps.repositories.groups.list().map((group) => [group.id, group.name]),
    );

    const projects: ExportedProject[] = this.deps.repositories.projects.list().map((config) => {
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

    for (const item of bundle.projects) {
      try {
        const groupId = item.group ? this.deps.groups.ensureByName(item.group).id : null;
        this.createProject({
          name: item.name,
          description: item.description ?? null,
          groupId,
          workingDirectory: item.workingDirectory,
          runtime: item.runtime,
          environment: item.environment ?? {},
          port: item.port ?? null,
          portSource:
            item.portSource ?? (item.port !== null && item.port !== undefined ? 'fixed' : 'none'),
          enabled: item.enabled ?? true,
          startOnBoot: item.startOnBoot ?? false,
          startupOrder: item.startupOrder ?? 0,
          ...(item.restartPolicy !== undefined ? { restartPolicy: item.restartPolicy } : {}),
          ...(item.healthCheck !== undefined ? { healthCheck: item.healthCheck } : {}),
          ...(item.logging !== undefined ? { logging: item.logging } : {}),
          ...(item.shutdown !== undefined ? { shutdown: item.shutdown } : {}),
        });
        results.push({ name: item.name, success: true });
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
