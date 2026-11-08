import { z } from 'zod';
import { AppError } from '@lsm/shared';

export const groupNameSchema = z.string().trim().min(1, 'nome é obrigatório').max(80);

export const createGroupRequestSchema = z.strictObject({
  name: groupNameSchema,
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

export const updateGroupRequestSchema = z.strictObject({
  name: groupNameSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export type CreateGroupInput = z.output<typeof createGroupRequestSchema>;
export type UpdateGroupInput = z.output<typeof updateGroupRequestSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Configuração inválida: ${label}`,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function parseCreateGroupRequest(input: unknown): CreateGroupInput {
  return parse(createGroupRequestSchema, input, 'grupo');
}

export function parseUpdateGroupRequest(input: unknown): UpdateGroupInput {
  return parse(updateGroupRequestSchema, input, 'grupo');
}
