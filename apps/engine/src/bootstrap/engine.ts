import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  ENGINE_SETTINGS_KEY,
  type EngineApiInfo,
  type EngineInfo,
  type EngineSettings,
} from '@lsm/contracts';
import { DEFAULT_ENGINE_SETTINGS, resolveAppPaths, type AppPaths } from '@lsm/config';
import {
  createRepositories,
  migrate,
  openDatabase,
  type AppDatabase,
  type Repositories,
} from '@lsm/database';
import type { Clock, Logger, TimerHandle } from '@lsm/shared';
import { createFileSink, createLogger, createStreamSink, createSystemClock } from '@lsm/shared';
import { AppError } from '@lsm/shared';
import { parseEngineSettings } from '@lsm/validation';
import { createApiServer, type ApiServer } from '../api/server';
import { generateApiToken } from '../api/auth';
import { WebAuth } from '../api/web-auth';
import { WebHosts } from '../api/web-hosts';
import { EventBus } from '../core/event-bus';
import { LogManager } from '../log-manager/log-manager';
import { runLogRetention } from '../log-manager/log-retention';
import { ProcessManager } from '../process-manager/process-manager';
import { MetricsCollector } from '../metrics/metrics-collector';
import { applyPendingRestore, BackupManager } from '../backup/backup-manager';
import { CertificateManager } from '../proxy/certificate-manager';
import { DomainService } from '../domains/domain-service';
import { HostsManager } from '../proxy/hosts-file';
import { ProjectService } from '../supervisor/project-service';
import { GroupService } from '../supervisor/group-service';
import { StackService } from '../supervisor/stack-service';
import { Supervisor } from '../supervisor/supervisor';
import { StaticHostManager } from '../static/static-host';
import { TunnelManager } from '../tunnels/tunnel-manager';
import { reconcileInstances } from './reconciliation';
import { acquireInstanceLock, type InstanceLock } from './single-instance';

const LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface CreateEngineOptions {
  /** Sobrescreve o diretório de dados (testes e CLI). */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  logger?: Logger;
  /** Desabilita o lock de instância única (somente diagnóstico/testes). */
  singleInstance?: boolean;
  /** Portas do proxy de domínios (0 = efêmera, para testes). */
  domainPorts?: { httpPort?: number; httpsPort?: number };
  /** Arquivo hosts alternativo (testes). */
  hostsFile?: string;
  /** Diretório da UI web servida pelo Engine (null desabilita). */
  webDir?: string | null;
}

export interface Engine {
  readonly paths: AppPaths;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly db: AppDatabase;
  readonly repositories: Repositories;
  readonly events: EventBus;
  readonly logManager: LogManager;
  readonly processManager: ProcessManager;
  readonly supervisor: Supervisor;
  readonly stacks: StackService;
  readonly projects: ProjectService;
  readonly groups: GroupService;
  readonly domains: DomainService;
  readonly tunnels: TunnelManager;
  readonly metrics: MetricsCollector;
  readonly backups: BackupManager;
  start(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  info(): EngineInfo;
}

export function createEngine(options: CreateEngineOptions = {}): Engine {
  const paths = resolveAppPaths({ dataDir: options.dataDir, env: options.env });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.backupsDir, { recursive: true });
  mkdirSync(paths.engineDir, { recursive: true });

  const clock = options.clock ?? createSystemClock();
  const logger =
    options.logger ??
    createLogger({
      level: DEFAULT_ENGINE_SETTINGS.logLevel,
      base: { app: 'engine' },
      sinks: [createStreamSink(process.stdout), createFileSink(paths.engineLogFile)],
    });

  // Restauração pendente é aplicada com o banco fechado, antes de abrir.
  applyPendingRestore({
    databaseFile: paths.databaseFile,
    backupsDir: paths.backupsDir,
    restoreMarkerFile: paths.restoreMarkerFile,
    logger,
  });

  const db = openDatabase({ file: paths.databaseFile });
  const backups = new BackupManager({
    databaseFile: paths.databaseFile,
    backupsDir: paths.backupsDir,
    restoreMarkerFile: paths.restoreMarkerFile,
    logger,
    checkpoint: () => {
      try {
        db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // checkpoint best-effort
      }
    },
  });
  const repositories = createRepositories(db.connection);
  const events = new EventBus(clock, logger);
  const webAuth = new WebAuth(repositories, clock);
  const webHosts = new WebHosts(repositories, clock);
  const logManager = new LogManager({
    logsDir: paths.logsDir,
    clock,
    logger,
    events,
  });
  const processManager = new ProcessManager(logger);
  const staticHost = new StaticHostManager();
  const postgresRoot = join(paths.root, 'postgres');
  const supervisor = new Supervisor({
    repositories,
    logManager,
    events,
    clock,
    logger,
    processManager,
    staticHost,
    postgresRoot,
    batchConcurrency: DEFAULT_ENGINE_SETTINGS.batchConcurrency,
  });
  const groups = new GroupService({ repositories, clock, logger });
  const stacks = new StackService({
    repositories,
    supervisor,
    clock,
    logger,
    batchConcurrency: DEFAULT_ENGINE_SETTINGS.batchConcurrency,
  });
  const certificates = new CertificateManager({
    certsDir: join(paths.root, 'certs'),
    logger,
  });
  const hosts = new HostsManager({ logger, filePath: options.hostsFile });
  const domains = new DomainService({
    repositories,
    supervisor,
    clock,
    logger,
    certificates,
    hosts,
    ports: options.domainPorts,
  });
  const tunnels = new TunnelManager({
    repositories,
    logManager,
    processManager,
    events,
    clock,
    logger,
  });
  const projects = new ProjectService({
    repositories,
    supervisor,
    groups,
    logManager,
    processManager,
    events,
    clock,
    logger,
    postgresRoot,
    postgresBackupsDir: join(paths.backupsDir, 'postgres'),
  });
  const metrics = new MetricsCollector({
    clock,
    logger,
    events,
    intervalMs: DEFAULT_ENGINE_SETTINGS.metricsIntervalMs,
    targets: () => {
      const summaries = supervisor.listSummaries();
      const targets = summaries.flatMap((summary) =>
        summary.runtime.status === 'RUNNING' && summary.runtime.pid !== null
          ? [
              {
                projectId: summary.config.id,
                pid: summary.runtime.pid,
                startedAt: summary.runtime.startedAt,
              },
            ]
          : [],
      );
      return {
        targets,
        stats: {
          managed: summaries.length,
          running: targets.length,
          crashed: summaries.filter(
            (summary) =>
              summary.runtime.status === 'CRASHED' || summary.runtime.status === 'FAILED',
          ).length,
        },
      };
    },
  });

  let lock: InstanceLock | null = null;
  let startedAt: string | null = null;
  let starting = false;
  let started = false;
  let shuttingDown = false;
  let retentionTimer: TimerHandle | null = null;
  let apiServer: ApiServer | null = null;
  let apiInfo: EngineApiInfo | null = null;
  let engineSettings: EngineSettings = DEFAULT_ENGINE_SETTINGS;

  const runRetention = (): void => {
    try {
      const projects = repositories.projects.list();
      const retentionByProject = new Map<string, number>(
        projects.map((project) => [project.id, project.logging.retentionDays]),
      );
      const result = runLogRetention({
        logsDir: paths.logsDir,
        retentionByProject,
        activeInstanceIds: new Set(logManager.activeInstanceIds()),
        nowMs: clock.nowMs(),
        logger,
      });
      if (result.removedFiles > 0) {
        logger.info('Retenção de logs aplicada', { ...result });
      }
    } catch (error) {
      logger.warn('Falha ao aplicar retenção de logs', {}, error);
    }
  };

  const scheduleRetention = (): void => {
    retentionTimer = clock.setTimeout(() => {
      retentionTimer = null;
      runRetention();
      scheduleRetention();
    }, LOG_RETENTION_INTERVAL_MS);
    retentionTimer.unref();
  };

  const engine: Engine = {
    paths,
    logger,
    clock,
    db,
    repositories,
    events,
    logManager,
    processManager,
    supervisor,
    stacks,
    projects,
    groups,
    domains,
    tunnels,
    metrics,
    backups,

    async start(): Promise<void> {
      if (started || starting) {
        return;
      }
      starting = true;
      try {
        if (options.singleInstance !== false) {
          lock = await acquireInstanceLock(paths.engineLockKey);
        }

        const migration = migrate(db.connection, {
          databaseFile: paths.databaseFile,
          backupDir: paths.backupsDir,
          now: () => clock.nowIso(),
        });
        if (migration.applied.length > 0) {
          logger.info('Migrações aplicadas', {
            versions: migration.applied,
            backup: migration.backupFile,
          });
        }

        const storedSettings = repositories.settings.get<unknown>(ENGINE_SETTINGS_KEY);
        if (storedSettings !== null) {
          try {
            engineSettings = parseEngineSettings(storedSettings);
          } catch (error) {
            logger.warn('Configuração do Engine inválida no banco; usando padrões', {}, error);
            engineSettings = DEFAULT_ENGINE_SETTINGS;
          }
        }
        supervisor.setBatchConcurrency(engineSettings.batchConcurrency);
        stacks.setBatchConcurrency(engineSettings.batchConcurrency);

        for (const config of repositories.projects.list()) {
          supervisor.registerProject(config);
        }
        tunnels.initialize();

        const reconciliation = await reconcileInstances({ repositories, clock, logger });

        apiServer = createApiServer({
          token: generateApiToken(),
          supervisor,
          stacks,
          projects,
          groups,
          domains,
          tunnels,
          repositories,
          logManager,
          events,
          clock,
          logger,
          metrics,
          backups,
          webAuth,
          webHosts,
          webDir: options.webDir ?? null,
          preferredPort: (options.webDir ?? null) === null ? 0 : 4_317,
          engineInfo: () => engine.info(),
          getSettings: () => engineSettings,
          updateSettings: (input: unknown): EngineSettings => {
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              throw new AppError('VALIDATION_ERROR', 'Configuração do Engine deve ser um objeto');
            }
            const merged = parseEngineSettings({
              ...engineSettings,
              ...(input as Record<string, unknown>),
            });
            repositories.settings.set(ENGINE_SETTINGS_KEY, merged);
            engineSettings = merged;
            supervisor.setBatchConcurrency(merged.batchConcurrency);
            stacks.setBatchConcurrency(merged.batchConcurrency);
            metrics.setIntervalMs(merged.metricsIntervalMs);
            logger.info('Configuração do Engine atualizada', { ...merged });
            return merged;
          },
        });
        apiInfo = await apiServer.start();

        startedAt = clock.nowIso();
        writeFileSync(paths.engineInfoFile, `${JSON.stringify(engine.info(), null, 2)}\n`, 'utf8');

        started = true;
        events.emit('engine.ready', {
          pid: process.pid,
          dataDir: paths.root,
          startedAt,
        });
        repositories.events.append({
          projectId: null,
          instanceId: null,
          level: 'info',
          eventType: 'engine.ready',
          message: 'Engine iniciado',
          metadata: { pid: process.pid, dataDir: paths.root },
          createdAt: startedAt,
        });
        logger.info('Engine pronto', {
          pid: process.pid,
          dataDir: paths.root,
          projects: repositories.projects.list().length,
        });

        runRetention();
        scheduleRetention();
        metrics.setIntervalMs(engineSettings.metricsIntervalMs);
        metrics.start();

        await domains.startIfConfigured();

        await stacks
          .startBootProjects(new Set(reconciliation.blockedProjectIds))
          .catch((error: unknown) => {
            logger.warn('Falha ao iniciar projetos de boot', {}, error);
          });
        await tunnels.startBootTunnels();
      } catch (error) {
        started = false;
        await apiServer?.stop().catch(() => undefined);
        apiServer = null;
        apiInfo = null;
        await lock?.release().catch(() => undefined);
        lock = null;
        throw error;
      } finally {
        starting = false;
      }
    },

    async shutdown(reason = 'manual'): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      try {
        events.emit('engine.shutdown', { reason });
        repositories.events.append({
          projectId: null,
          instanceId: null,
          level: 'info',
          eventType: 'engine.shutdown',
          message: `Engine encerrando (${reason})`,
          metadata: { reason },
        });
        logger.info('Encerrando Engine', { reason });
        // Para de aceitar comandos antes de mexer nos projetos (docs/03 §10).
        await apiServer?.stop().catch((error: unknown) => {
          logger.warn('Falha ao encerrar API local', {}, error);
        });
        apiServer = null;
        apiInfo = null;
        metrics.stop();
        await domains.shutdown().catch((error: unknown) => {
          logger.warn('Falha ao encerrar o proxy de domínios', {}, error);
        });
        await tunnels.shutdown();
        await supervisor.shutdown();
        await staticHost.stopAll();
        await logManager.closeAll();
      } finally {
        if (retentionTimer) {
          clock.clearTimeout(retentionTimer);
          retentionTimer = null;
        }
        try {
          unlinkSync(paths.engineInfoFile);
        } catch {
          // Arquivo de info pode não existir se o start falhou.
        }
        await lock?.release().catch(() => undefined);
        lock = null;
        db.close();
        started = false;
      }
    },

    info(): EngineInfo {
      return {
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION,
        dataDir: paths.root,
        startedAt: startedAt ?? clock.nowIso(),
        projects: supervisor.listProjects().length,
        api: apiInfo,
      };
    },
  };

  return engine;
}
