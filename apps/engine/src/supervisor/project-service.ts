import type { ListEventsOptions, SystemEvent } from '@lsm/database';
import type { LogRecord, ProjectConfig, ProjectSummary } from '@lsm/contracts';
import { CURRENT_CONFIG_SCHEMA_VERSION } from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, newId } from '@lsm/shared';
import { parseCreateProjectRequest } from '@lsm/validation';
import type { EventBus } from '../core/event-bus';
import type { LogManager } from '../log-manager/log-manager';
import { isActiveStatus } from './project-runtime';
import type { Supervisor } from './supervisor';

export interface ProjectServiceDeps {
  repositories: Repositories;
  supervisor: Supervisor;
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

  tailLogs(projectIdOrName: string, limit = 50): TailLogsResult {
    const config = this.getProject(projectIdOrName);
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
