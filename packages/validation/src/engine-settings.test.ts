import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { parseEngineSettings } from './engine-settings';

describe('parseEngineSettings', () => {
  it('aplica defaults', () => {
    expect(parseEngineSettings({})).toEqual({
      shutdownBehavior: 'stop-all',
      batchConcurrency: 4,
      logLevel: 'info',
      metricsIntervalMs: 5_000,
    });
  });

  it('aceita valores válidos', () => {
    const settings = parseEngineSettings({
      shutdownBehavior: 'stop-all',
      batchConcurrency: 8,
      logLevel: 'debug',
      metricsIntervalMs: 10_000,
    });
    expect(settings.batchConcurrency).toBe(8);
    expect(settings.logLevel).toBe('debug');
  });

  it('rejeita keep-running enquanto não há suporte a processos destacados', () => {
    try {
      parseEngineSettings({ shutdownBehavior: 'keep-running' });
      throw new Error('esperava VALIDATION_ERROR');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejeita valores fora do intervalo e chaves desconhecidas', () => {
    expect(() => parseEngineSettings({ batchConcurrency: 0 })).toThrow(AppError);
    expect(() => parseEngineSettings({ batchConcurrency: 99 })).toThrow(AppError);
    expect(() => parseEngineSettings({ extra: true })).toThrow(AppError);
  });
});
