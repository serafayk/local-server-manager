import { statSync } from 'node:fs';
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
import type { Clock, Logger } from '@lsm/shared';
import { AppError, newId } from '@lsm/shared';
import type { EventBus } from '../core/event-bus';
import { OperationQueue } from '../core/operation-queue';
import type { LogManager } from '../log-manager/log-manager';
import type { ProcessManager } from '../process-manager/process-manager';
import type { ExitInfo, ManagedProcess } from '../process-manager/spawn-adapter';
import { RecoveryManager } from '../recovery/recovery-manager';

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
}

interface SpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
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

    const spec = this.buildSpawnSpec();
    const instanceId = newId();
    const startedRequestAt = this.deps.clock.nowIso();

    this.instanceIdValue = instanceId;
    this.pidValue = null;
    this.startedAtValue = null;
    this.finalizedInstanceId = null;
    this.exitWaiters = [];
    this.stopReason = null;
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
      `start solicitado (motivo=${reason}, executável=${spec.executable})`,
    );
    this.persistEvent('info', 'project.start.requested', `start solicitado (${reason})`, {
      executable: spec.executable,
      args: spec.args,
      cwd: spec.cwd,
    });

    let managed: ManagedProcess;
    try {
      managed = this.deps.processManager.spawn({
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
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

    managed.onStdout((chunk) =>
      this.deps.logManager.push(this.projectId, instanceId, 'stdout', chunk),
    );
    managed.onStderr((chunk) =>
      this.deps.logManager.push(this.projectId, instanceId, 'stderr', chunk),
    );
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

  private async doStop(reason: TerminationReason): Promise<void> {
    if (!isActiveStatus(this.statusValue)) {
      throw new AppError(
        'PROJECT_NOT_RUNNING',
        `Projeto "${this.configValue.name}" não está em execução`,
      );
    }

    const instanceId = this.instanceIdValue;
    const pid = this.pidValue;

    this.recovery.reset();
    this.desired = 'STOPPED';
    this.stopReason = reason;
    this.transition('STOPPING');
    if (instanceId) {
      this.deps.logManager.recordSystem(this.projectId, instanceId, `stop solicitado (${reason})`);
    }
    this.persistEvent('info', 'project.stop.requested', `stop solicitado (${reason})`, { pid });

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

    const exitInfo: ProcessExitInfo = { code: info.code, signal: info.signal, reason, at };

    this.pidValue = null;
    this.startedAtValue = null;
    this.lastExitValue = exitInfo;
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
      this.handleRecoveryAfterFailure();
    }
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
