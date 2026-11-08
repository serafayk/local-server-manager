import { z } from 'zod';
import { PORT_SOURCES } from '@lsm/contracts';
import { AppError } from '@lsm/shared';
import { projectNameSchema, runtimeConfigSchema, workingDirectorySchema } from './project-config';

export const exportedProjectSchema = z.strictObject({
  name: projectNameSchema,
  description: z.string().trim().max(2_000).nullable().optional(),
  group: z.string().trim().max(80).nullable().optional(),
  workingDirectory: workingDirectorySchema,
  runtime: runtimeConfigSchema,
  environment: z.record(z.string(), z.string().max(8_192)).optional(),
  maskedEnvironmentKeys: z.array(z.string().max(64)).max(100).optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
  portSource: z.enum(PORT_SOURCES).optional(),
  launchMode: z.enum(['auto', 'wrapper', 'direct']).optional(),
  serveMode: z.enum(['process', 'static']).optional(),
  outputDir: z.string().trim().max(1_024).nullable().optional(),
  dependsOn: z
    .array(
      z.strictObject({
        project: projectNameSchema,
        waitFor: z.enum(['started', 'ready']).default('ready'),
      }),
    )
    .max(32)
    .optional(),
  dependencyTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  enabled: z.boolean().optional(),
  startOnBoot: z.boolean().optional(),
  startupOrder: z.number().int().min(0).max(10_000).optional(),
  restartPolicy: z.record(z.string(), z.unknown()).optional(),
  healthCheck: z.record(z.string(), z.unknown()).optional(),
  logging: z.record(z.string(), z.unknown()).optional(),
  shutdown: z.record(z.string(), z.unknown()).optional(),
});

export const exportBundleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: z.string().optional(),
  projects: z.array(exportedProjectSchema).min(1).max(500),
});

export type ParsedExportBundle = z.output<typeof exportBundleSchema>;

export function parseExportBundle(input: unknown): ParsedExportBundle {
  const result = exportBundleSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Arquivo de configuração inválido',
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
