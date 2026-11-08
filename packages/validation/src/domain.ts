import { z } from 'zod';
import { AppError } from '@lsm/shared';
import { formatZodIssues } from './project-config';

/**
 * Domínios locais aceitos: `<label>.lsm`, `api.uai.lsm`, `app.localhost`.
 * `.localhost` funciona sem editar o arquivo hosts; `.lsm` exige sincronização.
 */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_PATTERN = new RegExp(`^(?:${LABEL}\\.)+(?:lsm|localhost)$`);

export const DOMAIN_SUFFIXES = ['.lsm', '.localhost'] as const;

export function normalizeDomainHost(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, '');
}

export function isValidDomainHost(host: string): boolean {
  if (host.length < 5 || host.length > 253) {
    return false;
  }
  if (!DOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false;
  }
  return HOST_PATTERN.test(host);
}

/** Alias que o navegador resolve para loopback sem configuração. */
export function localhostAliasOf(host: string): string {
  return host.endsWith('.lsm') ? `${host.slice(0, -'.lsm'.length)}.localhost` : host;
}

export const domainHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform(normalizeDomainHost)
  .refine(
    isValidDomainHost,
    'domínio deve terminar em .lsm ou .localhost e usar apenas letras, números e hífens',
  );

export const createDomainRequestSchema = z.strictObject({
  host: domainHostSchema,
  projectId: z.string().trim().min(1).max(64),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
});

export const updateDomainRequestSchema = z.strictObject({
  host: domainHostSchema.optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
});

export type ParsedCreateDomainRequest = z.output<typeof createDomainRequestSchema>;
export type ParsedUpdateDomainRequest = z.output<typeof updateDomainRequestSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Configuração inválida: ${label}`,
      formatZodIssues(result.error),
    );
  }
  return result.data;
}

export function parseCreateDomainRequest(input: unknown): ParsedCreateDomainRequest {
  return parseOrThrow(createDomainRequestSchema, input, 'domínio');
}

export function parseUpdateDomainRequest(input: unknown): ParsedUpdateDomainRequest {
  return parseOrThrow(updateDomainRequestSchema, input, 'domínio');
}
