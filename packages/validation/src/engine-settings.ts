import { z } from 'zod';
import type { EngineSettings } from '@lsm/contracts';
import { ENGINE_SETTINGS_KEY } from '@lsm/contracts';
import { AppError } from '@lsm/shared';

export const engineSettingsSchema = z.strictObject({
  shutdownBehavior: z.enum(['stop-all', 'keep-running']).default('stop-all'),
  batchConcurrency: z.number().int().min(1).max(32).default(4),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  metricsIntervalMs: z.number().int().min(1_000).max(600_000).default(5_000),
});

export function parseEngineSettings(input: unknown): EngineSettings {
  const result = engineSettingsSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Configuração do Engine inválida',
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  if (result.data.shutdownBehavior !== 'stop-all') {
    throw new AppError(
      'VALIDATION_ERROR',
      'shutdownBehavior "keep-running" ainda não é suportado: processos ficariam sem supervisor e sem canal de log (ADR-008/ADR-014).',
    );
  }
  return result.data;
}

export { ENGINE_SETTINGS_KEY };
