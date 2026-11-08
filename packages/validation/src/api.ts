import { z } from 'zod';
import { AppError } from '@lsm/shared';
import { projectNameSchema, workingDirectorySchema } from './project-config';

const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;

export const detectProjectRequestSchema = z.strictObject({
  directory: workingDirectorySchema,
});

export const scanRootRequestSchema = z.strictObject({
  directory: workingDirectorySchema,
});

export const importProjectRequestSchema = z.strictObject({
  directory: workingDirectorySchema,
  name: projectNameSchema.optional(),
  script: z.string().regex(SCRIPT_NAME_PATTERN, 'nome de script inválido').optional(),
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
  executable: z.string().trim().min(1).max(1_024).optional(),
  args: z.array(z.string().max(8_192)).max(64).optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
  startOnBoot: z.boolean().optional(),
  environment: z.record(z.string(), z.string().max(8_192)).optional(),
  groupId: z.string().trim().min(1).max(64).nullable().optional(),
  enabled: z.boolean().optional(),
  startupOrder: z.number().int().min(0).max(10_000).optional(),
  restartPolicy: z.record(z.string(), z.unknown()).optional(),
  healthCheck: z.record(z.string(), z.unknown()).optional(),
  logging: z.record(z.string(), z.unknown()).optional(),
  shutdown: z.record(z.string(), z.unknown()).optional(),
});

export const bulkProjectsRequestSchema = z.strictObject({
  projectIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export const restoreBackupRequestSchema = z.strictObject({
  file: z.string().trim().min(1).max(512),
});

export type DetectProjectInput = z.output<typeof detectProjectRequestSchema>;
export type ScanRootInput = z.output<typeof scanRootRequestSchema>;
export type ImportProjectInput = z.output<typeof importProjectRequestSchema>;
export type BulkProjectsInput = z.output<typeof bulkProjectsRequestSchema>;
export type RestoreBackupInput = z.output<typeof restoreBackupRequestSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Corpo inválido: ${label}`,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function parseDetectProjectRequest(input: unknown): DetectProjectInput {
  return parse(detectProjectRequestSchema, input, 'detecção de projeto');
}

export function parseScanRootRequest(input: unknown): ScanRootInput {
  return parse(scanRootRequestSchema, input, 'varredura da raiz do projeto');
}

export function parseImportProjectRequest(input: unknown): ImportProjectInput {
  return parse(importProjectRequestSchema, input, 'importação de projeto');
}

export function parseBulkProjectsRequest(input: unknown): BulkProjectsInput {
  return parse(bulkProjectsRequestSchema, input, 'operações em lote');
}

export function parseRestoreBackupRequest(input: unknown): RestoreBackupInput {
  return parse(restoreBackupRequestSchema, input, 'restauração de backup');
}
