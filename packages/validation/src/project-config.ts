import { z } from 'zod';
import type {
  ComposeServiceConfig,
  HealthCheckConfig,
  LaunchMode,
  LoggingConfig,
  PortSource,
  PostgresServiceConfig,
  ProjectConfig,
  ProjectDependency,
  ProjectKind,
  RestartPolicy,
  RuntimeConfig,
  ServeMode,
  ShutdownConfig,
} from '@lsm/contracts';
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  DEPENDENCY_WAITS,
  LAUNCH_MODES,
  PORT_SOURCES,
  PROJECT_KINDS,
  SERVE_MODES,
} from '@lsm/contracts';
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

export const projectDependencySchema = z.strictObject({
  projectId: z.string().trim().min(1).max(64),
  waitFor: z.enum(DEPENDENCY_WAITS).default('ready'),
});

export const dependencyTimeoutSchema = z.number().int().min(1_000).max(600_000).default(60_000);

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

export const projectKindSchema = z.enum(PROJECT_KINDS).default('node');

export const composeServiceSchema = z.strictObject({
  file: z
    .string()
    .trim()
    .min(1, 'caminho do docker-compose é obrigatório')
    .max(1_024)
    .refine((value) => !CONTROL_CHARS.test(value), 'caminho inválido'),
  projectName: z
    .string()
    .trim()
    .max(63)
    .refine((value) => value === '' || /^[a-z0-9][a-z0-9_-]*$/i.test(value), 'nome inválido')
    .nullable()
    .optional(),
  dockerExecutable: z.string().trim().max(1_024).nullable().optional(),
});

export const postgresServiceSchema = z.strictObject({
  version: z.string().trim().max(32).nullable().optional(),
  binDir: z.string().trim().max(1_024).nullable().optional(),
  dataDir: z.string().trim().max(1_024).nullable().optional(),
  username: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/i, 'usuário inválido')
    .default('postgres'),
  password: z.string().max(128).default(''),
  port: z.number().int().min(1_024).max(65_535).nullable().optional(),
});

export const composePatchSchema = z.strictObject({
  file: z.string().trim().min(1).max(1_024).optional(),
  projectName: z.string().trim().max(63).nullable().optional(),
  dockerExecutable: z.string().trim().max(1_024).nullable().optional(),
});

export const postgresPatchSchema = z.strictObject({
  version: z.string().trim().max(32).nullable().optional(),
  binDir: z.string().trim().max(1_024).nullable().optional(),
  dataDir: z.string().trim().max(1_024).nullable().optional(),
  username: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/i, 'usuário inválido')
    .optional(),
  password: z.string().max(128).optional(),
  port: z.number().int().min(1_024).max(65_535).nullable().optional(),
});

export const createProjectRequestSchema = z
  .strictObject({
    name: projectNameSchema,
    description: z.string().trim().max(2_000).nullable().optional(),
    groupId: z.string().trim().min(1).max(64).nullable().optional(),
    workingDirectory: workingDirectorySchema,
    runtime: runtimeConfigSchema,
    launchMode: z.enum(LAUNCH_MODES).default('auto'),
    serveMode: z.enum(SERVE_MODES).default('process'),
    outputDir: z.string().trim().max(1_024).nullable().optional(),
    kind: projectKindSchema,
    compose: composeServiceSchema.nullable().optional(),
    postgres: postgresServiceSchema.nullable().optional(),
    stopCommand: runtimeConfigSchema.nullable().optional(),
    environment: environmentSchema,
    dependsOn: z.array(projectDependencySchema).max(32).default([]),
    dependencyTimeoutMs: dependencyTimeoutSchema,
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
    const seen = new Set<string>();
    value.dependsOn.forEach((dependency, index) => {
      if (seen.has(dependency.projectId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['dependsOn', index, 'projectId'],
          message: `dependência duplicada: ${dependency.projectId}`,
        });
      }
      seen.add(dependency.projectId);
    });

    if (value.kind === 'compose' && !value.compose) {
      ctx.addIssue({
        code: 'custom',
        path: ['compose'],
        message: 'compose é obrigatório para projetos Docker Compose',
      });
    }
    if (value.kind === 'postgres' && !value.postgres) {
      ctx.addIssue({
        code: 'custom',
        path: ['postgres'],
        message: 'postgres é obrigatório para projetos PostgreSQL',
      });
    }
    if (value.postgres?.password && value.postgres.password.length < 8) {
      ctx.addIssue({
        code: 'custom',
        path: ['postgres', 'password'],
        message: 'a senha do Postgres deve ter ao menos 8 caracteres',
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
  launchMode: LaunchMode;
  serveMode: ServeMode;
  outputDir: string | null;
  kind: ProjectKind;
  compose: ComposeServiceConfig | null;
  postgres: PostgresServiceConfig | null;
  stopCommand: RuntimeConfig | null;
  environment: Record<string, string>;
  dependsOn: ProjectDependency[];
  dependencyTimeoutMs: number;
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
    launchMode: parsed.launchMode,
    serveMode: parsed.serveMode,
    outputDir: parsed.outputDir ?? null,
    kind: parsed.kind,
    compose: parsed.compose
      ? {
          file: parsed.compose.file,
          projectName: parsed.compose.projectName ?? null,
          dockerExecutable: parsed.compose.dockerExecutable ?? null,
        }
      : null,
    postgres: parsed.postgres
      ? {
          version: parsed.postgres.version ?? null,
          binDir: parsed.postgres.binDir ?? null,
          dataDir: parsed.postgres.dataDir ?? null,
          username: parsed.postgres.username,
          password: parsed.postgres.password,
          port: parsed.postgres.port ?? null,
        }
      : null,
    stopCommand: parsed.stopCommand
      ? {
          executable: parsed.stopCommand.executable,
          args: [...parsed.stopCommand.args],
        }
      : null,
    environment: { ...parsed.environment },
    dependsOn: parsed.dependsOn.map((dependency) => ({ ...dependency })),
    dependencyTimeoutMs: parsed.dependencyTimeoutMs,
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

/**
 * Atualização parcial de projeto (PUT). Campos aninhados são mesclados com a
 * configuração atual e o resultado passa pela validação completa — assim uma
 * atualização nunca produz configuração inválida nem apaga defaults.
 */
export const updateProjectRequestSchema = z.strictObject({
  name: projectNameSchema.optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  groupId: z.string().trim().min(1).max(64).nullable().optional(),
  workingDirectory: workingDirectorySchema.optional(),
  runtime: runtimeConfigSchema.optional(),
  launchMode: z.enum(LAUNCH_MODES).optional(),
  serveMode: z.enum(SERVE_MODES).optional(),
  outputDir: z.string().trim().max(1_024).nullable().optional(),
  kind: z.enum(PROJECT_KINDS).optional(),
  compose: composePatchSchema.nullable().optional(),
  postgres: postgresPatchSchema.nullable().optional(),
  stopCommand: runtimeConfigSchema.nullable().optional(),
  environment: z.record(z.string(), z.string().max(8_192)).optional(),
  dependsOn: z.array(projectDependencySchema).max(32).optional(),
  // Sem `.default()` aqui: no PUT, ausência do campo significa "não alterar".
  dependencyTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
  portSource: z.enum(PORT_SOURCES).optional(),
  enabled: z.boolean().optional(),
  startOnBoot: z.boolean().optional(),
  startupOrder: z.number().int().min(0).max(10_000).optional(),
  restartPolicy: z.record(z.string(), z.unknown()).optional(),
  healthCheck: z.record(z.string(), z.unknown()).optional(),
  logging: z.record(z.string(), z.unknown()).optional(),
  shutdown: z.record(z.string(), z.unknown()).optional(),
});

export type ParsedUpdateProjectRequest = z.output<typeof updateProjectRequestSchema>;

export function parseUpdateProjectRequest(
  existing: ProjectConfig,
  input: unknown,
  updatedAt: string,
): ProjectConfig {
  const patch = parseOrThrow(updateProjectRequestSchema, input, 'atualização de projeto');

  const merged: Record<string, unknown> = { ...existing, updatedAt };
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.groupId !== undefined) merged.groupId = patch.groupId;
  if (patch.workingDirectory !== undefined) merged.workingDirectory = patch.workingDirectory;
  if (patch.runtime !== undefined) merged.runtime = patch.runtime;
  if (patch.launchMode !== undefined) merged.launchMode = patch.launchMode;
  if (patch.serveMode !== undefined) merged.serveMode = patch.serveMode;
  if (patch.outputDir !== undefined) merged.outputDir = patch.outputDir;
  if (patch.kind !== undefined) merged.kind = patch.kind;
  if (patch.compose !== undefined) {
    merged.compose =
      patch.compose === null ? null : { ...(existing.compose ?? {}), ...patch.compose };
  }
  if (patch.postgres !== undefined) {
    merged.postgres =
      patch.postgres === null ? null : { ...(existing.postgres ?? {}), ...patch.postgres };
  }
  if (patch.stopCommand !== undefined) merged.stopCommand = patch.stopCommand;
  if (patch.environment !== undefined) merged.environment = patch.environment;
  if (patch.dependsOn !== undefined) merged.dependsOn = patch.dependsOn;
  if (patch.dependencyTimeoutMs !== undefined) {
    merged.dependencyTimeoutMs = patch.dependencyTimeoutMs;
  }
  if (patch.port !== undefined) merged.port = patch.port;
  if (patch.portSource !== undefined) merged.portSource = patch.portSource;
  if (patch.enabled !== undefined) merged.enabled = patch.enabled;
  if (patch.startOnBoot !== undefined) merged.startOnBoot = patch.startOnBoot;
  if (patch.startupOrder !== undefined) merged.startupOrder = patch.startupOrder;
  if (patch.restartPolicy !== undefined) {
    merged.restartPolicy = { ...existing.restartPolicy, ...patch.restartPolicy };
  }
  if (patch.healthCheck !== undefined) {
    merged.healthCheck = { ...existing.healthCheck, ...patch.healthCheck };
  }
  if (patch.logging !== undefined) {
    merged.logging = { ...existing.logging, ...patch.logging };
  }
  if (patch.shutdown !== undefined) {
    merged.shutdown = { ...existing.shutdown, ...patch.shutdown };
  }

  return parseProjectConfig(merged);
}
