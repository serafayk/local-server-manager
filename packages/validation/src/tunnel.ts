import { z } from 'zod';
import { AppError } from '@lsm/shared';

export const tunnelKindSchema = z.enum(['config', 'token', 'quick']);

const nameSchema = z.string().trim().min(1, 'nome é obrigatório').max(80);

export const createTunnelRequestSchema = z.strictObject({
  name: nameSchema,
  kind: tunnelKindSchema,
  configPath: z.string().trim().max(1_024).nullable().optional(),
  targetPort: z.number().int().min(1).max(65_535).nullable().optional(),
  projectId: z.string().trim().max(64).nullable().optional(),
  token: z.string().max(8_192).nullable().optional(),
  enabled: z.boolean().optional(),
  startOnBoot: z.boolean().optional(),
});

export const updateTunnelRequestSchema = z.strictObject({
  name: nameSchema.optional(),
  kind: tunnelKindSchema.optional(),
  configPath: z.string().trim().max(1_024).nullable().optional(),
  targetPort: z.number().int().min(1).max(65_535).nullable().optional(),
  projectId: z.string().trim().max(64).nullable().optional(),
  token: z.string().max(8_192).nullable().optional(),
  clearToken: z.boolean().optional(),
  enabled: z.boolean().optional(),
  startOnBoot: z.boolean().optional(),
});

export type CreateTunnelInput = z.output<typeof createTunnelRequestSchema>;
export type UpdateTunnelInput = z.output<typeof updateTunnelRequestSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Configuração de túnel inválida: ${label}`,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function parseCreateTunnelRequest(input: unknown): CreateTunnelInput {
  return parse(createTunnelRequestSchema, input, 'criação');
}

export function parseUpdateTunnelRequest(input: unknown): UpdateTunnelInput {
  return parse(updateTunnelRequestSchema, input, 'atualização');
}
