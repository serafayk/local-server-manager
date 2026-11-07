import type { RestartPolicy } from '@lsm/contracts';
import type { Clock, TimerHandle } from '@lsm/shared';
import { computeBackoffDelay } from './backoff-policy';
import { RetryBudget } from './retry-budget';

export type RecoveryDecision =
  | { action: 'restart'; attempt: number; delayMs: number }
  | { action: 'exhausted'; attempt: number; delayMs: 0 }
  | { action: 'disabled'; attempt: number; delayMs: 0 };

export interface RecoveryCallbacks {
  onRetry: (attempt: number) => void;
  /** Chamado quando o projeto ficou estável; recebe as falhas antes do reset. */
  onStable: (attemptsBeforeReset: number) => void;
}

export interface RecoveryManagerOptions {
  clock: Clock;
  policy: RestartPolicy;
  callbacks: RecoveryCallbacks;
  random?: () => number;
}

/**
 * Decide e agenda reinícios automáticos.
 *
 * - `stableAfterMs <= 0` desliga o reset automático (evita loop infinito).
 * - O timer de retry é cancelado por stop/start manual/shutdown.
 * - O timer de estabilidade só reseta o orçamento; não reinicia nada.
 */
export class RecoveryManager {
  private readonly budget: RetryBudget;
  private readonly clock: Clock;
  private readonly callbacks: RecoveryCallbacks;
  private readonly random: () => number;
  private policy: RestartPolicy;
  private retryTimer: TimerHandle | null = null;
  private stableTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(options: RecoveryManagerOptions) {
    this.clock = options.clock;
    this.policy = options.policy;
    this.callbacks = options.callbacks;
    this.random = options.random ?? Math.random;
    this.budget = new RetryBudget(options.policy.maxRetries);
  }

  get attempts(): number {
    return this.budget.attempts;
  }

  /** Registra falha inesperada e, se permitido, agenda um retry. */
  registerUnexpectedExit(): RecoveryDecision {
    this.cancelStableTimer();

    if (!this.policy.enabled) {
      return { action: 'disabled', attempt: this.budget.attempts, delayMs: 0 };
    }

    const attempt = this.budget.registerFailure();
    if (!this.budget.canRetry()) {
      this.cancelRetryTimer();
      return { action: 'exhausted', attempt, delayMs: 0 };
    }

    const delayMs = computeBackoffDelay({
      attempt,
      baseDelayMs: this.policy.baseDelayMs,
      maxDelayMs: this.policy.maxDelayMs,
      jitterRatio: this.policy.jitterRatio,
      random: this.random,
    });

    this.cancelRetryTimer();
    if (!this.disposed) {
      this.retryTimer = this.clock.setTimeout(() => {
        this.retryTimer = null;
        if (!this.disposed) {
          this.callbacks.onRetry(this.budget.attempts);
        }
      }, delayMs);
      this.retryTimer.unref();
    }

    return { action: 'restart', attempt, delayMs };
  }

  /** Marca início bem-sucedido e inicia a janela de estabilidade. */
  markRunning(): void {
    this.cancelStableTimer();
    if (this.disposed || !this.policy.enabled || !this.policy.resetRetriesAfterStable) {
      return;
    }
    if (this.policy.stableAfterMs <= 0) {
      return;
    }

    this.stableTimer = this.clock.setTimeout(() => {
      this.stableTimer = null;
      const previous = this.budget.attempts;
      this.budget.reset();
      if (!this.disposed) {
        this.callbacks.onStable(previous);
      }
    }, this.policy.stableAfterMs);
    this.stableTimer.unref();
  }

  cancelPendingRetry(): void {
    this.cancelRetryTimer();
  }

  /** Cancelamento por intenção do usuário: zera o ciclo de retry. */
  reset(): void {
    this.cancelRetryTimer();
    this.cancelStableTimer();
    this.budget.reset();
  }

  updatePolicy(policy: RestartPolicy): void {
    this.policy = policy;
    this.budget.setMaxRetries(policy.maxRetries);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetryTimer();
    this.cancelStableTimer();
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private cancelStableTimer(): void {
    if (this.stableTimer) {
      this.clock.clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }
}
