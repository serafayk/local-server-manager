import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DesiredState,
  HealthStatus,
  ProcessExitInfo,
  ProjectConfig,
  ProjectStatus,
  RuntimeSnapshot,
  StartReason,
  TerminationReason,
} from '@lsm/contracts';
import { canTransition } from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import { assertDirectlySpawnable, resolveExecutable } from '@lsm/platform-win';
import type { Clock, Logger, TimerHandle } from '@lsm/shared';
import { AppError, newId } from '@lsm/shared';
import type { EventBus } from '../core/event-bus';
import { OperationQueue } from '../core/operation-queue';
import { composeDownArgs, composeUpSpec } from '../compose/command-builder';
import type { LogManager } from '../log-manager/log-manager';
import { resolveLaunch, resolveStaticRoot } from '../launch/launch-resolver';
import type { ProcessManager } from '../process-manager/process-manager';
import type { ExitInfo, ManagedProcess } from '../process-manager/spawn-adapter';
import { checkPort } from '../ports/port-checker';
import {
  initdbSpec,
  isInitialized,
  postgresSpawnSpec,
  resolvePostgresConfig,
  type ResolvedPostgres,
} from '../postgres/command-builder';
import {
  ensurePostgresService,
  postgresLogFile,
  postgresServiceName,
  queryPostgresService,
  startPostgresService,
  stopPostgresService,
} from '../postgres/service-manager';
import { HealthMonitor } from '../health-monitor/health-monitor';
import { RecoveryManager } from '../recovery/recovery-manager';
import type { StaticHostManager } from '../static/static-host';

export const ACTIVE_STATUSES: readonly ProjectStatus[] = [
  'STARTING',
  'RUNNING',
  'STOPPING',
  'RESTARTING',
];

export function isActiveStatus(status: ProjectStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export interface ProjectRuntimeDeps {
  config: ProjectConfig;
  repositories: Repositories;
  logManager: LogManager;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  processManager: ProcessManager;
  staticHost: StaticHostManager;
  /** Raiz dos data dirs de Postgres gerenciados pelo Engine. */
  postgresRoot: string;
}

interface FailureDiagnosis {
  hint: string;
  /** Quando false, a política de retry não deve insistir (erro de configuração/ambiente). */
  retryable: boolean;
}

const FAILURE_PATTERNS: ReadonlyArray<{ pattern: RegExp; hint: string; retryable: boolean }> = [
  {
    pattern: /EADDRINUSE|address already in use/i,
    hint: 'Porta já está em uso. Encerre o processo que a ocupa ou altere a porta do projeto.',
    retryable: false,
  },
  {
    pattern:
      /Cannot connect to the Docker daemon|error during connect|docker daemon is not running/i,
    hint: 'Docker não está rodando. Abra o Docker Desktop e inicie o projeto novamente.',
    retryable: false,
  },
  {
    pattern: /'docker' não é reconhecido|'docker' is not recognized|spawn docker ENOENT/i,
    hint: 'Docker CLI não encontrado. Instale o Docker Desktop e reabra o app.',
    retryable: false,
  },
  {
    pattern: /production-start-no-build-id|Could not find a production build/i,
    hint: 'Build de produção ausente: rode o build do projeto ou use o script "dev".',
    retryable: false,
  },
  {
    pattern: /Cannot find module|MODULE_NOT_FOUND/i,
    hint: 'Dependência ausente: instale as dependências do projeto.',
    retryable: false,
  },
  {
    pattern: /ECONNREFUSED\s+127\.0\.0\.1:5432|ECONNREFUSED.*postgres|connect ECONNREFUSED/i,
    hint: 'Serviço externo indisponível (ex.: PostgreSQL). Inicie-o antes do projeto.',
    retryable: false,
  },
  {
    pattern: /EACCES|EPERM/i,
    hint: 'Permissão negada ao acessar arquivo ou porta.',
    retryable: false,
  },
  {
    pattern: /ENOENT/i,
    hint: 'Arquivo ou diretório não encontrado. Confira o comando e o diretório do projeto.',
    retryable: false,
  },
];

function diagnoseFailure(text: string): FailureDiagnosis | null {
  for (const entry of FAILURE_PATTERNS) {
    if (entry.pattern.test(text)) {
      return { hint: entry.hint, retryable: entry.retryable };
    }
  }
  return null;
}

interface SpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  launchMode?: 'direct' | 'wrapper';
  launchNote?: string | null;
}

/**
 * Máquina de estados de um projeto. Toda operação pública passa pela
 * OperationQueue, garantindo que start/stop/restart do mesmo projeto nunca
 * se intercalem.
 */
export class ProjectRuntime {
  private configValue: ProjectConfig;
  private statusValue: ProjectStatus = 'STOPPED';
  private desired: DesiredState = 'STOPPED';
  private healthValue: HealthStatus = 'UNKNOWN';
  private instanceIdValue: string | null = null;
  private pidValue: number | null = null;
  private startedAtValue: string | null = null;
  private restartAttemptValue = 0;
  private lastExitValue: ProcessExitInfo | null = null;
  private updatedAtValue: string;
  private stopReason: TerminationReason | null = null;
  private finalizedInstanceId: string | null = null;
  private exitWaiters: Array<() => void> = [];
  private readonly queue = new OperationQueue();
  private readonly recovery: RecoveryManager;
  private readonly healthMonitor: HealthMonitor;
  private portInUseValue: boolean | null = null;
  private lastFailureHintValue: string | null = null;
  private outputBuffer = '';
  private serviceMonitor: TimerHandle | null = null;
  private logTimer: TimerHandle | null = null;
  private logFile: string | null = null;
  private logOffset = 0;
  private disposed = false;

  constructor(private readonly deps: ProjectRuntimeDeps) {
    this.configValue = deps.config;
    this.updatedAtValue = deps.clock.nowIso();
    this.recovery = new RecoveryManager({
      clock: deps.clock,
      policy: deps.config.restartPolicy,
      callbacks: {
        onRetry: (attempt) => this.handleRecoveryRetry(attempt),
        onStable: (previousAttempts) => this.handleStable(previousAttempts),
      },
    });
    this.healthMonitor = new HealthMonitor({
      config: deps.config.healthCheck,
      clock: deps.clock,
      onChanged: (health, detail) => this.handleHealthChanged(health, detail),
      onRestartRequested: (detail) => this.handleHealthRestart(detail),
    });
  }

  get projectId(): string {
    return this.configValue.id;
  }

  get config(): ProjectConfig {
    return this.configValue;
  }

  get status(): ProjectStatus {
    return this.statusValue;
  }

  snapshot(): RuntimeSnapshot {
    return {
      projectId: this.configValue.id,
      status: this.statusValue,
      desiredState: this.desired,
      health: this.healthValue,
      instanceId: this.instanceIdValue,
      pid: this.pidValue,
      startedAt: this.startedAtValue,
      restartAttempt: this.restartAttemptValue,
      lastExit: this.lastExitValue,
      updatedAt: this.updatedAtValue,
      portInUse: this.portInUseValue,
      lastFailureHint: this.lastFailureHintValue,
    };
  }

  /** Atualização de configuração só é permitida com o projeto parado. */
  setConfig(config: ProjectConfig): void {
    if (isActiveStatus(this.statusValue)) {
      throw new AppError(
        'ENGINE_BUSY',
        `Não é possível alterar "${this.configValue.name}" enquanto ele está ${this.statusValue}`,
      );
    }
    this.configValue = config;
    this.recovery.updatePolicy(config.restartPolicy);
    this.healthMonitor.updateConfig(config.healthCheck);
  }

  start(reason: StartReason = 'USER'): Promise<void> {
    return this.queue.run(() => this.doStart(reason));
  }

  stop(reason: TerminationReason = 'STOP_MANUAL'): Promise<void> {
    return this.queue.run(() => this.doStop(reason));
  }

  restart(): Promise<void> {
    return this.queue.run(async () => {
      if (isActiveStatus(this.statusValue)) {
        await this.doStop('RESTART_MANUAL');
      }
      await this.doStart('RESTART');
    });
  }

  /** Encerramento do Engine: para o projeto sem disparar recuperação. */
  async dispose(): Promise<void> {
    await this.queue.run(async () => {
      if (isActiveStatus(this.statusValue)) {
        try {
          await this.doStop('ENGINE_SHUTDOWN');
        } catch (error) {
          this.deps.logger.error(
            'Falha ao encerrar projeto durante shutdown do Engine',
            { projectId: this.projectId },
            error,
          );
        }
      }
      if (this.instanceIdValue) {
        await this.deps.logManager.closeInstance(this.instanceIdValue);
      }
    });
    this.disposed = true;
    this.recovery.dispose();
    this.healthMonitor.stop();
  }

  private async doStart(reason: StartReason): Promise<void> {
    if (reason !== 'RECOVERY') {
      this.recovery.reset();
      this.restartAttemptValue = 0;
    }
    if (!this.configValue.enabled) {
      throw new AppError(
        'PROJECT_INVALID_CONFIG',
        `Projeto "${this.configValue.name}" está desabilitado`,
      );
    }
    // RESTARTING é ativo, mas aceita o retry agendado (e start manual imediato).
    if (isActiveStatus(this.statusValue) && this.statusValue !== 'RESTARTING') {
      throw new AppError(
        'PROJECT_ALREADY_RUNNING',
        `Projeto "${this.configValue.name}" já está ${this.statusValue}`,
      );
    }

    const staticMode = this.configValue.serveMode === 'static';
    const spec = staticMode ? null : this.buildSpawnSpec();
    const instanceId = newId();
    const startedRequestAt = this.deps.clock.nowIso();

    this.instanceIdValue = instanceId;
    this.pidValue = null;
    this.startedAtValue = null;
    this.finalizedInstanceId = null;
    this.exitWaiters = [];
    this.stopReason = null;
    this.portInUseValue = null;
    this.lastFailureHintValue = null;
    this.outputBuffer = '';
    this.desired = 'RUNNING';

    this.transition('STARTING');

    this.tryPersist(() =>
      this.deps.repositories.instances.create({
        id: instanceId,
        projectId: this.projectId,
        status: 'STARTING',
        createdAt: startedRequestAt,
      }),
    );
    this.deps.logManager.registerInstance(this.configValue, instanceId);
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      staticMode
        ? `start solicitado (motivo=${reason}, modo estático)`
        : `start solicitado (motivo=${reason}, executável=${spec?.executable}${
            spec?.launchMode === 'direct' ? ', execução direta' : ''
          })`,
    );
    this.persistEvent('info', 'project.start.requested', `start solicitado (${reason})`, {
      executable: spec?.executable ?? 'static',
      args: spec?.args ?? [],
      cwd: staticMode ? this.configValue.workingDirectory : (spec?.cwd ?? ''),
      launchMode: spec?.launchMode ?? 'static',
    });

    await this.checkConfiguredPort(instanceId);

    if (staticMode) {
      await this.startStatic(instanceId);
      return;
    }

    if (this.configValue.kind === 'postgres') {
      await this.startPostgres(instanceId);
      return;
    }

    const spawnSpec = spec as SpawnSpec;

    let managed: ManagedProcess;
    try {
      managed = this.deps.processManager.spawn({
        executable: spawnSpec.executable,
        args: spawnSpec.args,
        cwd: spawnSpec.cwd,
        env: spawnSpec.env,
      });
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      this.handleExit(instanceId, { code: null, signal: null }, spawnError);
      throw new AppError(
        'PROJECT_START_FAILED',
        `Falha ao iniciar "${this.configValue.name}"`,
        undefined,
        { cause: error },
      );
    }

    managed.onStdout((chunk) => {
      this.captureOutput(chunk);
      this.deps.logManager.push(this.projectId, instanceId, 'stdout', chunk);
    });
    managed.onStderr((chunk) => {
      this.captureOutput(chunk);
      this.deps.logManager.push(this.projectId, instanceId, 'stderr', chunk);
    });
    managed.onExit((info) => this.handleExit(instanceId, info));
    managed.onError((error) => this.handleExit(instanceId, { code: null, signal: null }, error));

    const spawned = await this.waitForSpawn(managed);
    if (!spawned) {
      if (this.finalizedInstanceId !== instanceId) {
        this.handleExit(
          instanceId,
          { code: null, signal: null },
          new Error('spawn não confirmado'),
        );
      }
      throw new AppError(
        'PROJECT_START_FAILED',
        `Falha ao iniciar "${this.configValue.name}": processo não confirmou spawn`,
      );
    }

    if (this.instanceIdValue !== instanceId || this.statusValue !== 'STARTING') {
      // O processo já saiu entre o spawn e este ponto; o exit handler cuidou do estado.
      return;
    }

    const startedAt = this.deps.clock.nowIso();
    this.pidValue = managed.pid;
    this.startedAtValue = startedAt;

    this.tryPersist(() =>
      this.deps.repositories.instances.markRunning({
        id: instanceId,
        pid: managed.pid,
        pidStartedAt: startedAt,
        startedAt,
      }),
    );

    this.transition('RUNNING');
    this.restartAttemptValue = this.recovery.attempts;
    this.recovery.markRunning();
    this.healthMonitor.start();
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `processo iniciado (pid=${managed.pid})`,
    );
    this.persistEvent('info', 'project.process.started', `processo iniciado (pid=${managed.pid})`, {
      pid: managed.pid,
    });
    this.deps.events.emit(
      'project.process.started',
      { projectId: this.projectId, instanceId, pid: managed.pid, startedAt },
      this.projectId,
    );
  }

  /**
   * Sobe o conteúdo estático no próprio Engine (sem processo filho) e mantém
   * o mesmo ciclo de vida/estado dos projetos comuns.
   */
  private async startStatic(instanceId: string): Promise<void> {
    const port = this.configValue.port;
    if (port === null) {
      return this.failStatic(
        instanceId,
        `Modo estático exige uma porta fixa em "${this.configValue.name}"`,
        'Defina uma porta fixa para servir o projeto estático.',
      );
    }
    const root = resolveStaticRoot(this.configValue);
    if (root === null) {
      return this.failStatic(
        instanceId,
        `Nenhum diretório estático (dist/build/out) encontrado para "${this.configValue.name}"`,
        'Rode o build do projeto ou ajuste o diretório de saída.',
      );
    }

    try {
      await this.deps.staticHost.start({ projectId: this.projectId, root, port });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const inUse = /EADDRINUSE|address already in use/i.test(error.message);
      return this.failStatic(
        instanceId,
        `Falha ao servir "${this.configValue.name}" na porta ${port}: ${error.message}`,
        inUse
          ? `Porta ${port} já está em uso. Encerre o processo que a ocupa ou altere a porta.`
          : 'Não foi possível iniciar o servidor estático.',
      );
    }

    if (this.instanceIdValue !== instanceId || this.statusValue !== 'STARTING') {
      return;
    }

    const startedAt = this.deps.clock.nowIso();
    this.startedAtValue = startedAt;
    this.updatedAtValue = startedAt;
    this.healthValue = 'HEALTHY';
    this.pidValue = null;
    this.tryPersist(() =>
      this.deps.repositories.instances.markRunning({
        id: instanceId,
        pid: null,
        pidStartedAt: null,
        startedAt,
      }),
    );
    this.transition('RUNNING');
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `servindo estático de ${root} em http://127.0.0.1:${port}`,
    );
    this.persistEvent('info', 'project.process.started', `servindo estático (porta ${port})`, {
      root,
      port,
    });
  }

  private failStatic(instanceId: string, message: string, hint: string): never {
    const at = this.deps.clock.nowIso();
    this.lastFailureHintValue = hint;
    this.desired = 'STOPPED';
    this.healthValue = 'UNKNOWN';
    this.startedAtValue = null;
    this.pidValue = null;
    this.updatedAtValue = at;
    this.safeTransition('FAILED');
    this.tryPersist(() =>
      this.deps.repositories.instances.finish({
        id: instanceId,
        endedAt: at,
        exitCode: null,
        exitSignal: null,
        terminationReason: 'EXIT_UNEXPECTED',
        status: 'FAILED',
      }),
    );
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `falha no modo estático: ${message}`,
    );
    this.persistEvent('error', 'project.crashed', message, { hint, static: true });
    void this.deps.logManager.closeInstance(instanceId).catch(() => undefined);
    throw new AppError('PROJECT_START_FAILED', message);
  }

  private async stopStatic(instanceId: string): Promise<void> {
    await this.deps.staticHost.stop(this.projectId);
    const at = this.deps.clock.nowIso();
    this.healthValue = 'UNKNOWN';
    this.startedAtValue = null;
    this.pidValue = null;
    this.updatedAtValue = at;
    this.safeTransition('STOPPED');
    this.tryPersist(() =>
      this.deps.repositories.instances.finish({
        id: instanceId,
        endedAt: at,
        exitCode: 0,
        exitSignal: null,
        terminationReason: this.stopReason ?? 'STOP_MANUAL',
        status: 'STOPPED',
      }),
    );
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `stop do modo estático (${this.stopReason ?? 'STOP_MANUAL'})`,
    );
    await this.deps.logManager.closeInstance(instanceId);
  }

  private async doStop(reason: TerminationReason): Promise<void> {
    if (!isActiveStatus(this.statusValue)) {
      throw new AppError(
        'PROJECT_NOT_RUNNING',
        `Projeto "${this.configValue.name}" não está em execução`,
      );
    }

    const instanceId = this.instanceIdValue;
    const pid = this.pidValue;

    this.healthMonitor.stop();
    this.resetHealth('processo parando');
    this.recovery.reset();
    this.desired = 'STOPPED';
    this.stopReason = reason;
    this.transition('STOPPING');
    if (instanceId) {
      this.deps.logManager.recordSystem(this.projectId, instanceId, `stop solicitado (${reason})`);
    }
    this.persistEvent('info', 'project.stop.requested', `stop solicitado (${reason})`, { pid });

    if (this.configValue.serveMode === 'static' && instanceId !== null) {
      await this.stopStatic(instanceId);
      return;
    }

    if (this.configValue.kind === 'postgres' && instanceId !== null) {
      await this.stopPostgres(instanceId);
      return;
    }

    if (pid === null || instanceId === null) {
      this.safeTransition('STOPPED');
      return;
    }

    const outcome = await this.deps.processManager.stop(pid, {
      gracefulTimeoutMs: this.configValue.shutdown.gracefulTimeoutMs,
    });

    if (outcome === 'timeout') {
      this.stopReason = 'STOP_TIMEOUT';
      this.handleExit(instanceId, { code: null, signal: null });
      throw new AppError(
        'PROJECT_STOP_TIMEOUT',
        `Timeout ao encerrar "${this.configValue.name}" (pid ${pid})`,
      );
    }

    const finalized = await this.waitForFinalize(instanceId, 3_000);
    if (!finalized) {
      this.stopReason = 'STOP_TIMEOUT';
      this.handleExit(instanceId, { code: null, signal: null });
      throw new AppError(
        'PROJECT_STOP_TIMEOUT',
        `Processo ${pid} de "${this.configValue.name}" não confirmou encerramento`,
      );
    }
    // Garante que o arquivo de log esteja fechado antes de retornar ao chamador.
    await this.deps.logManager.closeInstance(instanceId);

    if (this.configValue.kind === 'compose') {
      await this.cleanupCompose(instanceId);
    }
  }

  /**
   * PostgreSQL dedicado roda como serviço do Windows (NetworkService): o
   * `postgres.exe` se recusa a iniciar sob token de administrador, comum em
   * máquinas com UAC desabilitado.
   */
  private async startPostgres(instanceId: string): Promise<void> {
    const resolved = resolvePostgresConfig(this.configValue, this.deps.postgresRoot);
    const serviceName = postgresServiceName(this.projectId);

    await this.preparePostgres(instanceId);
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `registrando serviço ${serviceName} (porta ${resolved.port})`,
    );
    await ensurePostgresService(resolved, serviceName);
    await startPostgresService(serviceName);

    this.startPostgresLogTail(resolved, instanceId);
    this.startServiceMonitor(instanceId, serviceName);

    if (this.instanceIdValue !== instanceId || this.statusValue !== 'STARTING') {
      return;
    }

    const startedAt = this.deps.clock.nowIso();
    this.startedAtValue = startedAt;
    this.updatedAtValue = startedAt;
    this.healthValue = 'HEALTHY';
    this.pidValue = null;
    this.tryPersist(() =>
      this.deps.repositories.instances.markRunning({
        id: instanceId,
        pid: null,
        pidStartedAt: null,
        startedAt,
      }),
    );
    this.transition('RUNNING');
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `serviço ${serviceName} em execução em 127.0.0.1:${resolved.port}`,
    );
    this.persistEvent(
      'info',
      'project.process.started',
      `serviço ${serviceName} iniciado (porta ${resolved.port})`,
      { service: serviceName, port: resolved.port, dataDir: resolved.dataDir },
    );
  }

  private async stopPostgres(instanceId: string): Promise<void> {
    this.stopServiceMonitor();
    this.stopLogTail();

    const serviceName = postgresServiceName(this.projectId);
    const at = this.deps.clock.nowIso();
    try {
      await stopPostgresService(serviceName);
    } catch (error) {
      this.deps.logger.warn(
        'Falha ao parar o serviço PostgreSQL',
        { projectId: this.projectId, serviceName },
        error,
      );
      this.lastFailureHintValue =
        'O serviço do PostgreSQL não parou no tempo esperado. Verifique o serviço pelo Windows.';
    }

    this.healthValue = 'UNKNOWN';
    this.startedAtValue = null;
    this.pidValue = null;
    this.updatedAtValue = at;
    this.safeTransition('STOPPED');
    this.tryPersist(() =>
      this.deps.repositories.instances.finish({
        id: instanceId,
        endedAt: at,
        exitCode: 0,
        exitSignal: null,
        terminationReason: this.stopReason ?? 'STOP_MANUAL',
        status: 'STOPPED',
      }),
    );
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `serviço ${serviceName} parado (${this.stopReason ?? 'STOP_MANUAL'})`,
    );
    await this.deps.logManager.closeInstance(instanceId);
  }

  private startServiceMonitor(instanceId: string, serviceName: string): void {
    this.stopServiceMonitor();
    const tick = (): void => {
      void queryPostgresService(serviceName)
        .then((state) => {
          if (this.instanceIdValue !== instanceId || this.statusValue !== 'RUNNING') {
            return;
          }
          if (state === 'STOPPED' || state === 'NOT_FOUND') {
            this.deps.logManager.recordSystem(
              this.projectId,
              instanceId,
              `serviço ${serviceName} não está mais em execução (${state})`,
            );
            this.handleExit(instanceId, { code: null, signal: null });
            return;
          }
          this.serviceMonitor = this.deps.clock.setTimeout(tick, 2_000);
          this.serviceMonitor.unref();
        })
        .catch(() => {
          this.serviceMonitor = this.deps.clock.setTimeout(tick, 5_000);
          this.serviceMonitor.unref();
        });
    };
    this.serviceMonitor = this.deps.clock.setTimeout(tick, 2_000);
    this.serviceMonitor.unref();
  }

  private stopServiceMonitor(): void {
    if (this.serviceMonitor) {
      this.deps.clock.clearTimeout(this.serviceMonitor);
      this.serviceMonitor = null;
    }
  }

  /** Copia novas linhas do log do PostgreSQL para o log do projeto. */
  private startPostgresLogTail(resolved: ResolvedPostgres, instanceId: string): void {
    this.stopLogTail();
    this.logFile = postgresLogFile(resolved);

    const tick = (): void => {
      if (this.logFile !== null) {
        try {
          if (existsSync(this.logFile)) {
            const content = readFileSync(this.logFile);
            if (content.length < this.logOffset) {
              this.logOffset = 0;
            }
            if (content.length > this.logOffset) {
              const chunk = content.subarray(this.logOffset).toString('utf8');
              this.logOffset = content.length;
              if (chunk !== '') {
                this.deps.logManager.push(this.projectId, instanceId, 'stdout', chunk);
              }
            }
          }
        } catch {
          // leitura best-effort
        }
      }
      this.logTimer = this.deps.clock.setTimeout(tick, 700);
      this.logTimer.unref();
    };
    tick();
  }

  private stopLogTail(): void {
    if (this.logTimer) {
      this.deps.clock.clearTimeout(this.logTimer);
      this.logTimer = null;
    }
  }

  /**
   * `initdb` roda uma única vez, antes do primeiro start. O data dir é próprio
   * do projeto (o serviço 5432 do usuário não é tocado).
   */
  private async preparePostgres(instanceId: string): Promise<void> {
    const resolved = resolvePostgresConfig(this.configValue, this.deps.postgresRoot);
    if (isInitialized(resolved.dataDir)) {
      return;
    }
    if (resolved.password.trim() === '') {
      throw new AppError(
        'PROJECT_INVALID_CONFIG',
        `Defina uma senha para o PostgreSQL de "${this.configValue.name}" antes de iniciar.`,
      );
    }

    mkdirSync(resolved.dataDir, { recursive: true });
    const passwordFile = join(tmpdir(), `lsm-pg-${this.projectId}-${Date.now().toString(36)}.pw`);
    writeFileSync(passwordFile, resolved.password, 'utf8');

    const spec = initdbSpec(resolved, passwordFile);
    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `initdb em ${resolved.dataDir} (usuário ${resolved.username})`,
    );

    let managed: ManagedProcess;
    try {
      managed = this.deps.processManager.spawn({
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: { ...this.configValue.environment },
      });
      managed.onStdout((chunk) =>
        this.deps.logManager.push(this.projectId, instanceId, 'stdout', chunk),
      );
      managed.onStderr((chunk) =>
        this.deps.logManager.push(this.projectId, instanceId, 'stderr', chunk),
      );

      const code = await waitForExit(managed, 180_000, () =>
        this.deps.processManager.stop(managed.pid, { gracefulTimeoutMs: 5_000 }),
      );
      if (code !== 0) {
        throw new AppError(
          'PROJECT_START_FAILED',
          `initdb falhou para "${this.configValue.name}". O data dir precisa estar vazio e acessível: ${resolved.dataDir}`,
        );
      }
    } finally {
      // O arquivo de senha só pode sair depois que o initdb termina de lê-lo.
      rmSync(passwordFile, { force: true });
    }

    this.deps.logManager.recordSystem(
      this.projectId,
      instanceId,
      `initdb concluído (porta ${resolved.port})`,
    );
  }

  /** Garante que containers não fiquem órfãos quando o CLI é encerrado. */
  private async cleanupCompose(instanceId: string): Promise<void> {
    try {
      const spec = composeDownArgs(this.configValue);
      const managed = this.deps.processManager.spawn({
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: { ...this.configValue.environment },
      });
      managed.onStdout((chunk) =>
        this.deps.logManager.push(this.projectId, instanceId, 'stdout', chunk),
      );
      managed.onStderr((chunk) =>
        this.deps.logManager.push(this.projectId, instanceId, 'stderr', chunk),
      );
      await waitForExit(managed, 30_000, () =>
        this.deps.processManager.stop(managed.pid, { gracefulTimeoutMs: 3_000 }),
      );
      this.deps.logManager.recordSystem(
        this.projectId,
        instanceId,
        'docker compose down executado',
      );
    } catch (error) {
      this.deps.logger.warn(
        'Falha ao limpar containers do projeto Compose',
        { projectId: this.projectId },
        error,
      );
    }
  }

  private handleExit(instanceId: string, info: ExitInfo, spawnError?: Error): void {
    if (this.instanceIdValue !== instanceId) {
      return;
    }
    if (this.finalizedInstanceId === instanceId) {
      return;
    }
    this.finalizedInstanceId = instanceId;

    const at = this.deps.clock.nowIso();
    const reason = this.resolveTerminationReason(spawnError);
    const isCrash = reason === 'EXIT_UNEXPECTED' || reason === 'SPAWN_FAILED';
    const nextStatus: ProjectStatus = isCrash
      ? 'CRASHED'
      : reason === 'STOP_TIMEOUT'
        ? 'FAILED'
        : 'STOPPED';

    // Diagnóstico precisa ser lido antes de limpar o estado da instância.
    const portConflict = this.portInUseValue === true;
    const diagnosis = isCrash ? this.diagnoseCrash(portConflict, spawnError) : null;
    const abortRetry = isCrash && diagnosis !== null && !diagnosis.retryable;
    if (diagnosis) {
      this.lastFailureHintValue = diagnosis.hint;
    }

    const exitInfo: ProcessExitInfo = { code: info.code, signal: info.signal, reason, at };

    this.pidValue = null;
    this.startedAtValue = null;
    this.lastExitValue = exitInfo;
    this.healthMonitor.stop();
    this.resetHealth('processo encerrado');
    this.portInUseValue = null;
    if (!isCrash) {
      this.desired = 'STOPPED';
    }
    this.stopReason = null;

    this.updatedAtValue = at;
    this.safeTransition(nextStatus);

    this.tryPersist(() =>
      this.deps.repositories.instances.finish({
        id: instanceId,
        endedAt: at,
        exitCode: info.code,
        exitSignal: info.signal,
        terminationReason: reason,
        status: nextStatus,
      }),
    );

    const message = `processo encerrado (motivo=${reason}, code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`;
    this.deps.logManager.recordSystem(this.projectId, instanceId, message);
    this.persistEvent(
      isCrash ? 'error' : 'info',
      isCrash ? 'project.crashed' : 'project.process.exited',
      message,
      {
        code: info.code,
        signal: info.signal,
        reason,
        spawnError: spawnError?.message,
      },
    );

    this.deps.events.emit(
      'project.process.exited',
      {
        projectId: this.projectId,
        instanceId,
        pid: null,
        exitCode: info.code,
        signal: info.signal,
        reason,
      },
      this.projectId,
    );
    if (isCrash) {
      this.deps.events.emit(
        'project.crashed',
        { projectId: this.projectId, instanceId, reason, exitCode: info.code },
        this.projectId,
      );
    }

    for (const resolve of this.exitWaiters.splice(0)) {
      resolve();
    }
    void this.deps.logManager.closeInstance(instanceId).catch((error: unknown) => {
      this.deps.logger.error('Falha ao fechar arquivo de log', { instanceId }, error);
    });

    if (isCrash) {
      if (abortRetry && diagnosis) {
        this.desired = 'STOPPED';
        this.safeTransition('FAILED');
        const message = `reinício automático cancelado: ${diagnosis.hint}`;
        this.persistEvent('error', 'project.recovery.aborted', message, {
          cause: diagnosis.hint,
          portConflict,
          exitCode: info.code,
        });
        this.deps.logManager.recordSystem(this.projectId, instanceId, message);
        this.deps.events.emit(
          'project.recovery.aborted',
          { projectId: this.projectId, hint: diagnosis.hint, attempts: this.restartAttemptValue },
          this.projectId,
        );
        return;
      }
      this.handleRecoveryAfterFailure();
    }
  }

  /** Guarda a saída recente para diagnosticar a causa do crash. */
  private captureOutput(chunk: string | Buffer): void {
    if (this.outputBuffer.length >= 16_000) {
      return;
    }
    this.outputBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.outputBuffer.length > 32_000) {
      this.outputBuffer = this.outputBuffer.slice(-16_000);
    }
  }

  private diagnoseCrash(portConflict: boolean, spawnError?: Error): FailureDiagnosis | null {
    if (portConflict) {
      const port = this.configValue.port;
      return {
        hint:
          port === null
            ? 'Porta configurada já está em uso. Encerre o processo que a ocupa ou altere a porta.'
            : `Porta ${port} já está em uso. Encerre o processo que a ocupa ou altere a porta do projeto.`,
        retryable: false,
      };
    }
    if (spawnError) {
      const fromSpawn = diagnoseFailure(spawnError.message);
      if (fromSpawn) {
        return fromSpawn;
      }
    }
    return diagnoseFailure(this.outputBuffer);
  }

  /**
   * Aplica a política de retry após uma falha. Chamado no crash e também
   * quando um retry falha antes de conseguir spawn (ex.: diretório removido).
   */
  private handleRecoveryAfterFailure(): void {
    if (this.disposed) {
      return;
    }
    const decision = this.recovery.registerUnexpectedExit();
    this.restartAttemptValue = decision.attempt;

    if (decision.action === 'disabled') {
      if (this.statusValue === 'RESTARTING') {
        this.desired = 'STOPPED';
        this.safeTransition('FAILED');
        this.persistEvent(
          'error',
          'project.recovery.disabled',
          'reinício automático desabilitado durante o ciclo',
          { attempts: decision.attempt },
        );
      }
      return;
    }

    if (decision.action === 'exhausted') {
      this.desired = 'STOPPED';
      this.safeTransition('FAILED');
      const message = `tentativas de reinício esgotadas (${decision.attempt})`;
      this.persistEvent('error', 'project.recovery.exhausted', message, {
        attempts: decision.attempt,
      });
      this.deps.logManager.recordSystem(this.projectId, this.instanceIdValue ?? 'unknown', message);
      this.deps.events.emit(
        'project.recovery.exhausted',
        { projectId: this.projectId, attempts: decision.attempt },
        this.projectId,
      );
      return;
    }

    if (this.statusValue === 'CRASHED') {
      this.safeTransition('RESTARTING');
    }
    const message = `retry ${decision.attempt} agendado em ${decision.delayMs}ms`;
    this.persistEvent('warn', 'project.restart.scheduled', message, {
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    });
    this.deps.events.emit(
      'project.restart.scheduled',
      { projectId: this.projectId, attempt: decision.attempt, delayMs: decision.delayMs },
      this.projectId,
    );
  }

  private handleRecoveryRetry(attempt: number): void {
    if (this.disposed) {
      return;
    }
    void this.queue.run(async () => {
      if (this.statusValue !== 'RESTARTING') {
        // Stop/start manual ocorreu durante o backoff.
        return;
      }
      this.restartAttemptValue = attempt;
      this.persistEvent('warn', 'project.restart.started', `retry ${attempt} iniciado`, {
        attempt,
      });
      this.deps.events.emit(
        'project.restart.started',
        { projectId: this.projectId, attempt },
        this.projectId,
      );
      try {
        await this.doStart('RECOVERY');
      } catch (error) {
        this.deps.logger.error(
          'Falha no reinício automático',
          { projectId: this.projectId, attempt },
          error,
        );
        if (this.statusValue === 'RESTARTING') {
          this.handleRecoveryAfterFailure();
        }
      }
    });
  }

  private handleStable(previousAttempts: number): void {
    this.restartAttemptValue = 0;
    if (previousAttempts > 0) {
      this.persistEvent(
        'info',
        'project.recovery.stable',
        'contador de retries resetado após estabilidade',
        {
          previousAttempts,
        },
      );
      this.deps.logger.info('Projeto estável; contador de retries resetado', {
        projectId: this.projectId,
        previousAttempts,
      });
    }
  }

  private async checkConfiguredPort(instanceId: string): Promise<void> {
    const port = this.configValue.port;
    if (port === null) {
      return;
    }
    try {
      const check = await checkPort(port);
      this.portInUseValue = check.inUse;
      this.updatedAtValue = this.deps.clock.nowIso();
      this.deps.events.emit(
        'project.state.changed',
        { snapshot: this.snapshot(), previousStatus: this.statusValue },
        this.projectId,
      );
      if (!check.inUse) {
        return;
      }
      const message = `porta ${port} já está em uso (pid ${check.ownerPid ?? 'desconhecido'})`;
      this.persistEvent('warn', 'project.port.conflict', message, {
        port,
        ownerPid: check.ownerPid,
      });
      this.deps.logManager.recordSystem(this.projectId, instanceId, message);
      this.deps.events.emit(
        'project.port.conflict',
        {
          projectId: this.projectId,
          port,
          inUse: true,
          ownerPid: check.ownerPid,
        },
        this.projectId,
      );
    } catch (error) {
      this.deps.logger.warn(
        'Falha ao verificar a porta configurada',
        { projectId: this.projectId, port },
        error,
      );
      this.portInUseValue = null;
    }
  }

  private handleHealthChanged(health: HealthStatus, detail: string): void {
    if (this.disposed || this.healthValue === health) {
      return;
    }
    const previous = this.healthValue;
    this.healthValue = health;
    this.updatedAtValue = this.deps.clock.nowIso();

    this.deps.events.emit(
      'project.health.changed',
      { projectId: this.projectId, health, previousHealth: previous, detail },
      this.projectId,
    );
    this.persistEvent(
      health === 'UNHEALTHY' ? 'warn' : 'info',
      'project.health.changed',
      `health ${previous} -> ${health} (${detail})`,
      { health, previousHealth: previous, detail },
    );
    if (this.instanceIdValue) {
      this.deps.logManager.recordSystem(
        this.projectId,
        this.instanceIdValue,
        `health ${health}: ${detail}`,
      );
    }
  }

  private resetHealth(detail: string): void {
    if (this.healthValue === 'UNKNOWN') {
      return;
    }
    const previous = this.healthValue;
    this.healthValue = 'UNKNOWN';
    this.updatedAtValue = this.deps.clock.nowIso();
    this.deps.events.emit(
      'project.health.changed',
      { projectId: this.projectId, health: 'UNKNOWN', previousHealth: previous, detail },
      this.projectId,
    );
    this.persistEvent(
      'info',
      'project.health.changed',
      `health ${previous} -> UNKNOWN (${detail})`,
      { health: 'UNKNOWN', previousHealth: previous, detail },
    );
  }

  private handleHealthRestart(detail: string): void {
    if (this.disposed || this.statusValue !== 'RUNNING') {
      return;
    }
    void this.queue.run(async () => {
      if (this.statusValue !== 'RUNNING') {
        return;
      }
      this.persistEvent('warn', 'project.health.restart', 'reinício solicitado pelo health check', {
        detail,
      });
      try {
        await this.doStop('HEALTH_RESTART');
        await this.doStart('HEALTH_RESTART');
      } catch (error) {
        this.deps.logger.error(
          'Falha no restart solicitado pelo health check',
          { projectId: this.projectId },
          error,
        );
      }
    });
  }

  private resolveTerminationReason(spawnError?: Error): TerminationReason {
    if (this.stopReason) {
      return this.stopReason;
    }
    if (spawnError) {
      return 'SPAWN_FAILED';
    }
    return 'EXIT_UNEXPECTED';
  }

  private buildSpawnSpec(): SpawnSpec {
    const cwd = this.configValue.workingDirectory;
    if (this.configValue.kind === 'postgres') {
      const resolved = resolvePostgresConfig(this.configValue, this.deps.postgresRoot);
      return {
        ...postgresSpawnSpec(resolved),
        env: { ...this.configValue.environment },
        launchMode: 'direct',
        launchNote: `PostgreSQL ${resolved.version ?? ''} em 127.0.0.1:${resolved.port}`.trim(),
      };
    }
    if (this.configValue.kind === 'compose') {
      return {
        ...composeUpSpec(this.configValue),
        env: { ...this.configValue.environment },
        launchMode: 'direct',
        launchNote: 'docker compose up (anexado)',
      };
    }

    let isDirectory = false;
    try {
      isDirectory = statSync(cwd).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new AppError(
        'WORKING_DIRECTORY_NOT_FOUND',
        `Diretório de trabalho não encontrado: ${cwd}`,
        { cwd },
      );
    }

    const launch = resolveLaunch(this.configValue);
    if (launch.mode === 'direct') {
      this.deps.logger.info('Execução direta resolvida', {
        projectId: this.projectId,
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        reason: launch.reason,
      });
      return {
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        env: { ...this.configValue.environment, ...launch.extraEnv },
        launchMode: 'direct',
        launchNote: launch.reason,
      };
    }
    if (this.configValue.launchMode === 'direct') {
      throw new AppError(
        'PROJECT_INVALID_CONFIG',
        `Execução direta não foi possível para "${this.configValue.name}": ${
          launch.reason ?? 'motivo desconhecido'
        }`,
      );
    }

    const requested = this.configValue.runtime.executable;
    let executable: string;
    try {
      executable = resolveExecutable(requested, { cwd }).executable;
    } catch (error) {
      // Conveniência segura: "node" sempre pode usar o runtime do próprio Engine.
      if (/^node(\.exe)?$/i.test(requested.trim())) {
        executable = process.execPath;
      } else {
        throw error;
      }
    }
    assertDirectlySpawnable(executable);

    return {
      executable,
      args: this.configValue.runtime.args,
      cwd,
      env: { ...this.configValue.environment },
      launchMode: 'wrapper',
      launchNote: launch.reason,
    };
  }

  private waitForSpawn(managed: ManagedProcess): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      managed.onSpawn(() => finish(true));
      managed.onError(() => finish(false));
      const timer = setTimeout(() => finish(false), 15_000);
      timer.unref();
    });
  }

  private waitForFinalize(instanceId: string, timeoutMs: number): Promise<boolean> {
    if (this.finalizedInstanceId === instanceId) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish(this.finalizedInstanceId === instanceId), timeoutMs);
      timer.unref();
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        finish(true);
      });
    });
  }

  private transition(next: ProjectStatus): void {
    const previous = this.statusValue;
    if (!canTransition(previous, next)) {
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `Transição inválida ${previous} -> ${next} em "${this.configValue.name}"`,
      );
    }
    this.statusValue = next;
    this.updatedAtValue = this.deps.clock.nowIso();
    this.deps.events.emit(
      'project.state.changed',
      { snapshot: this.snapshot(), previousStatus: previous },
      this.projectId,
    );
  }

  /**
   * Transição usada em callbacks de processo: nunca propaga exceção para o
   * event loop. Uma transição inesperada é um bug, mas não pode matar o Engine.
   */
  private safeTransition(next: ProjectStatus): void {
    try {
      this.transition(next);
    } catch (error) {
      this.deps.logger.error(
        'Transição de estado inesperada; aplicando estado final diretamente',
        { projectId: this.projectId, from: this.statusValue, to: next },
        error,
      );
      const previous = this.statusValue;
      this.statusValue = next;
      this.updatedAtValue = this.deps.clock.nowIso();
      this.deps.events.emit(
        'project.state.changed',
        { snapshot: this.snapshot(), previousStatus: previous },
        this.projectId,
      );
    }
  }

  private persistEvent(
    level: 'debug' | 'info' | 'warn' | 'error',
    eventType: string,
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    this.tryPersist(() =>
      this.deps.repositories.events.append({
        projectId: this.projectId,
        instanceId: this.instanceIdValue,
        level,
        eventType,
        message,
        metadata,
      }),
    );
  }

  private tryPersist(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.deps.logger.error(
        'Falha de persistência durante ciclo de vida do projeto',
        { projectId: this.projectId },
        error,
      );
    }
  }
}

/** Espera o processo terminar (initdb/compose down) com timeout e kill. */
function waitForExit(
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
