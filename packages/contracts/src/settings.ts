export type EngineLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ShutdownBehavior = 'stop-all' | 'keep-running';

/**
 * Configuração do Engine persistida em `settings.engine.settings`.
 * ADR-008 define `stop-all` como default.
 */
export interface EngineSettings {
  shutdownBehavior: ShutdownBehavior;
  batchConcurrency: number;
  logLevel: EngineLogLevel;
  metricsIntervalMs: number;
}

export const ENGINE_SETTINGS_KEY = 'engine.settings';
