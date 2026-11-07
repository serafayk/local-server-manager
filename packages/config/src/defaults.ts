import type {
  EngineSettings,
  HealthCheckConfig,
  LoggingConfig,
  RestartPolicy,
  ShutdownConfig,
} from '@lsm/contracts';

/** docs/04-PROCESS-LIFECYCLE.md §4 — jitter desligado por padrão em ambiente local. */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  enabled: true,
  maxRetries: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  jitterRatio: 0,
  stableAfterMs: 60_000,
  resetRetriesAfterStable: true,
};

export const DEFAULT_HEALTH_CHECK: HealthCheckConfig = {
  enabled: false,
  type: 'http',
  target: '',
  expectedStatus: 200,
  intervalMs: 30_000,
  timeoutMs: 5_000,
  failureThreshold: 3,
  restartOnUnhealthy: false,
  unhealthyRestartCooldownMs: 60_000,
};

/** docs/10-LOGGING-MONITORING.md §4. */
export const DEFAULT_LOGGING: LoggingConfig = {
  maxFileSizeMb: 10,
  retentionDays: 7,
  captureOutput: true,
  maskPatterns: [],
};

export const DEFAULT_SHUTDOWN: ShutdownConfig = {
  gracefulTimeoutMs: 10_000,
};

/** Limite de concorrência para operações em lote. */
export const DEFAULT_BATCH_CONCURRENCY = 4;

export { type EngineSettings };

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  shutdownBehavior: 'stop-all',
  batchConcurrency: DEFAULT_BATCH_CONCURRENCY,
  logLevel: 'info',
  metricsIntervalMs: 5_000,
};
