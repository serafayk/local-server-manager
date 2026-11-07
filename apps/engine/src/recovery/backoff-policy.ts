export interface BackoffOptions {
  /** Tentativa (1-based) após a falha registrada. */
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0 desliga o jitter. */
  jitterRatio: number;
  /** Injetável para testes determinísticos. */
  random?: () => number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * `delay = min(baseDelay * 2^(attempt-1), maxDelay)`, com jitter opcional
 * simétrico (docs/04-PROCESS-LIFECYCLE.md §4).
 */
export function computeBackoffDelay(options: BackoffOptions): number {
  const attempt = Math.max(1, Math.floor(options.attempt));
  const base = Math.max(1, options.baseDelayMs);
  const max = Math.max(base, options.maxDelayMs);
  const exponential = Math.min(base * 2 ** (attempt - 1), max);
  const jitterRatio = clamp(options.jitterRatio, 0, 1);

  if (jitterRatio === 0) {
    return Math.round(exponential);
  }

  const random = options.random ?? Math.random;
  const factor = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.round(clamp(exponential * factor, 0, max));
}

export interface RetryPolicyInput {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  stableAfterMs: number;
  resetRetriesAfterStable: boolean;
}
