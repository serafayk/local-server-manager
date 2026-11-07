import { z } from 'zod';
import type {
  HealthCheckConfig,
  LoggingConfig,
  PortSource,
  ProjectConfig,
  RestartPolicy,
  RuntimeConfig,
  ShutdownConfig,
} from '@lsm/contracts';
import { CURRENT_CONFIG_SCHEMA_VERSION, PORT_SOURCES } from '@lsm/contracts';
import { AppError } from '@lsm/shared';

const MAX_ARG_COUNT = 64;
const MAX_ARG_LENGTH = 8_192;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ABSOLUTE = /^\//;
const CONTROL_CHARS = /[\0\r\n]/;

export interface ValidationIssue {
  path: string;
  message: string;
}

export function formatZodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

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

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'nome é obrigatório')
  .max(120, 'nome deve ter no máximo 120 caracteres')
  .refine((value) => !CONTROL_CHARS.test(value), 'nome não pode conter quebras de linha');

/**
 * Aceita apenas caminho absoluto. A existência é verificada em runtime, não
 * na validação sintática (a pasta pode estar indisponível no momento do parse).
 */
export const workingDirectorySchema = z
  .string()
  .trim()
  .min(3, 'workingDirectory é obrigatório')
  .max(2_048)
  .refine(
    (value) =>
      WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value) || POSIX_ABSOLUTE.test(value),
    'workingDirectory deve ser um caminho absoluto',
  )
  .refine((value) => !value.includes('\0'), 'workingDirectory não pode conter NUL');

export const runtimeConfigSchema = z.strictObject({
  executable: z
    .string()
    .trim()
    .min(1, 'executable é obrigatório')
    .max(1_024)
    .refine(
      (value) => !CONTROL_CHARS.test(value),
      'executable não pode conter caracteres de controle',
    ),
  args: z
    .array(
      z
        .string()
        .max(MAX_ARG_LENGTH, `cada argumento deve ter no máximo ${MAX_ARG_LENGTH} caracteres`)
        .refine((value) => !value.includes('\0'), 'argumento não pode conter NUL'),
    )
    .max(MAX_ARG_COUNT)
    .default([]),
});

export const environmentSchema = z
  .record(z.string(), z.string().max(8_192))
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!ENV_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `nome de variável de ambiente inválido: ${key}`,
        });
      }
    }
  })
  .default({});

export const portSchema = z.number().int().min(1).max(65_535).nullable().default(null);

export const portSourceSchema = z.enum(PORT_SOURCES).default('none');

export const restartPolicySchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    maxRetries: z.number().int().min(0).max(1_000).default(5),
    baseDelayMs: z.number().int().min(100).max(600_000).default(2_000),
    maxDelayMs: z.number().int().min(100).max(600_000).default(30_000),
    jitterRatio: z.number().min(0).max(1).default(0),
    stableAfterMs: z.number().int().min(0).max(86_400_000).default(60_000),
    resetRetriesAfterStable: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.maxDelayMs < value.baseDelayMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxDelayMs'],
        message: 'maxDelayMs deve ser maior ou igual a baseDelayMs',
      });
    }
  });

export const healthCheckSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    type: z.enum(['http', 'tcp']).default('http'),
    target: z.string().trim().max(2_048).default(''),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    intervalMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
    timeoutMs: z.number().int().min(100).max(120_000).default(5_000),
    failureThreshold: z.number().int().min(1).max(100).default(3),
    restartOnUnhealthy: z.boolean().default(false),
    unhealthyRestartCooldownMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) {
      return;
    }
    if (value.target === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'target é obrigatório quando healthCheck está habilitado',
      });
      return;
    }
    if (value.type === 'http' && !/^https?:\/\//i.test(value.target)) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'health check HTTP exige URL começando com http:// ou https://',
      });
    }
    if (value.type === 'tcp' && !/^[^\s:]+:\d{1,5}$/.test(value.target)) {
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'health check TCP exige host:porta',
      });
    }
    if (value.timeoutMs > value.intervalMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeoutMs'],
        message: 'timeoutMs deve ser menor ou igual a intervalMs',
      });
    }
  });

export const loggingSchema = z
  .strictObject({
    maxFileSizeMb: z.number().int().min(1).max(1_024).default(10),
    retentionDays: z.number().int().min(1).max(3_650).default(7),
    captureOutput: z.boolean().default(true),
    maskPatterns: z.array(z.string().max(512)).max(20).default([]),
  })
  .superRefine((value, ctx) => {
    value.maskPatterns.forEach((pattern, index) => {
      try {
        new RegExp(pattern);
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['maskPatterns', index],
          message: 'padrão de mascaramento não é uma expressão regular válida',
        });
      }
    });
  });

export const shutdownSchema = z.strictObject({
  gracefulTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
});

export const createProjectRequestSchema = z
  .strictObject({
    name: projectNameSchema,
    description: z.string().trim().max(2_000).nullable().optional(),
    groupId: z.string().trim().min(1).max(64).nullable().optional(),
    workingDirectory: workingDirectorySchema,
    runtime: runtimeConfigSchema,
    environment: environmentSchema,
    port: portSchema,
    portSource: portSourceSchema,
    enabled: z.boolean().default(true),
    startOnBoot: z.boolean().default(false),
    startupOrder: z.number().int().min(0).max(10_000).default(0),
    restartPolicy: restartPolicySchema.prefault({}),
    healthCheck: healthCheckSchema.prefault({}),
    logging: loggingSchema.prefault({}),
    shutdown: shutdownSchema.prefault({}),
  })
  .superRefine((value, ctx) => {
    if (value.portSource === 'fixed' && value.port === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['port'],
        message: 'port é obrigatório quando portSource é "fixed"',
      });
    }
  });

export type ParsedCreateProjectRequest = z.output<typeof createProjectRequestSchema>;

export const projectConfigSchema = createProjectRequestSchema.safeExtend({
  id: z.string().trim().min(1),
  schemaVersion: z.number().int().min(1),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});

export interface NormalizedProjectFields {
  name: string;
  description: string | null;
  groupId: string | null;
  workingDirectory: string;
  runtime: RuntimeConfig;
  environment: Record<string, string>;
  port: number | null;
  portSource: PortSource;
  enabled: boolean;
  startOnBoot: boolean;
  startupOrder: number;
  restartPolicy: RestartPolicy;
  healthCheck: HealthCheckConfig;
  logging: LoggingConfig;
  shutdown: ShutdownConfig;
}

function normalizeFields(parsed: ParsedCreateProjectRequest): NormalizedProjectFields {
  const portSource: PortSource =
    parsed.port !== null && parsed.portSource === 'none' ? 'fixed' : parsed.portSource;

  return {
    name: parsed.name,
    description: parsed.description ?? null,
    groupId: parsed.groupId ?? null,
    workingDirectory: parsed.workingDirectory,
    runtime: { executable: parsed.runtime.executable, args: [...parsed.runtime.args] },
    environment: { ...parsed.environment },
    port: parsed.port,
    portSource,
    enabled: parsed.enabled,
    startOnBoot: parsed.startOnBoot,
    startupOrder: parsed.startupOrder,
    restartPolicy: parsed.restartPolicy,
    healthCheck: parsed.healthCheck,
    logging: parsed.logging,
    shutdown: parsed.shutdown,
  };
}

/** Valida e normaliza a entrada de criação de projeto (CLI e API). */
export function parseCreateProjectRequest(input: unknown): NormalizedProjectFields {
  return normalizeFields(parseOrThrow(createProjectRequestSchema, input, 'criação de projeto'));
}

/** Valida a configuração completa vinda do banco (proteção contra corrupção manual). */
export function parseProjectConfig(input: unknown): ProjectConfig {
  const parsed = parseOrThrow(projectConfigSchema, input, 'configuração persistida');
  return {
    ...normalizeFields(parsed),
    id: parsed.id,
    schemaVersion: parsed.schemaVersion,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

export const CONFIG_SCHEMA_VERSION = CURRENT_CONFIG_SCHEMA_VERSION;
