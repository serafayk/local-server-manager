import type { ProjectConfig, ProjectDependency } from '@lsm/contracts';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type CommandMode = 'script' | 'custom';

export interface EnvironmentRow {
  key: string;
  value: string;
}

export interface ProjectFormState {
  name: string;
  description: string;
  directory: string;
  groupId: string;
  mode: CommandMode;
  launchMode: 'auto' | 'wrapper' | 'direct';
  serveMode: 'process' | 'static';
  outputDir: string;
  packageManager: PackageManager;
  script: string;
  executable: string;
  argsText: string;
  environment: EnvironmentRow[];
  dependsOn: ProjectDependency[];
  dependencyTimeoutMs: string;
  port: string;
  startOnBoot: boolean;
  enabled: boolean;
  startupOrder: string;
  restartEnabled: boolean;
  maxRetries: string;
  baseDelayMs: string;
  maxDelayMs: string;
  stableAfterMs: string;
  healthEnabled: boolean;
  healthType: 'http' | 'tcp';
  healthTarget: string;
  healthIntervalMs: string;
  healthTimeoutMs: string;
  healthFailureThreshold: string;
  healthRestartOnUnhealthy: boolean;
  gracefulTimeoutMs: string;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ABSOLUTE = /^\//;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCRIPT_NAME = /^[A-Za-z0-9:_.-]{1,64}$/;

export function emptyFormState(): ProjectFormState {
  return {
    name: '',
    description: '',
    directory: '',
    groupId: '',
    mode: 'custom',
    launchMode: 'auto',
    serveMode: 'process',
    outputDir: '',
    packageManager: 'npm',
    script: 'dev',
    executable: 'node',
    argsText: 'server.js',
    environment: [],
    dependsOn: [],
    dependencyTimeoutMs: '60000',
    port: '',
    startOnBoot: false,
    enabled: true,
    startupOrder: '0',
    restartEnabled: true,
    maxRetries: '5',
    baseDelayMs: '2000',
    maxDelayMs: '30000',
    stableAfterMs: '60000',
    healthEnabled: false,
    healthType: 'http',
    healthTarget: '',
    healthIntervalMs: '30000',
    healthTimeoutMs: '5000',
    healthFailureThreshold: '3',
    healthRestartOnUnhealthy: false,
    gracefulTimeoutMs: '10000',
  };
}

export function formStateFromConfig(config: ProjectConfig): ProjectFormState {
  return {
    name: config.name,
    description: config.description ?? '',
    directory: config.workingDirectory,
    groupId: config.groupId ?? '',
    mode: 'custom',
    launchMode: config.launchMode ?? 'auto',
    serveMode: config.serveMode ?? 'process',
    outputDir: config.outputDir ?? '',
    packageManager: 'npm',
    script: 'dev',
    executable: config.runtime.executable,
    argsText: config.runtime.args.join('\n'),
    environment: Object.entries(config.environment).map(([key, value]) => ({ key, value })),
    dependsOn: (config.dependsOn ?? []).map((dependency) => ({ ...dependency })),
    dependencyTimeoutMs: String(config.dependencyTimeoutMs ?? 60_000),
    port: config.port === null ? '' : String(config.port),
    startOnBoot: config.startOnBoot,
    enabled: config.enabled,
    startupOrder: String(config.startupOrder),
    restartEnabled: config.restartPolicy.enabled,
    maxRetries: String(config.restartPolicy.maxRetries),
    baseDelayMs: String(config.restartPolicy.baseDelayMs),
    maxDelayMs: String(config.restartPolicy.maxDelayMs),
    stableAfterMs: String(config.restartPolicy.stableAfterMs),
    healthEnabled: config.healthCheck.enabled,
    healthType: config.healthCheck.type,
    healthTarget: config.healthCheck.target,
    healthIntervalMs: String(config.healthCheck.intervalMs),
    healthTimeoutMs: String(config.healthCheck.timeoutMs),
    healthFailureThreshold: String(config.healthCheck.failureThreshold),
    healthRestartOnUnhealthy: config.healthCheck.restartOnUnhealthy,
    gracefulTimeoutMs: String(config.shutdown.gracefulTimeoutMs),
  };
}

/** Um argumento por linha; linha vazia é ignorada. */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function buildEnvironment(rows: EnvironmentRow[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') {
      continue;
    }
    environment[key] = row.value;
  }
  return environment;
}

export type MemoryProfile = 'off' | 'low' | 'medium' | 'high' | 'custom';

export interface MemoryProfilePreset {
  value: MemoryProfile;
  label: string;
  heapMb?: number;
  semiSpaceMb?: number;
}

/** Presets aplicados via NODE_OPTIONS (herdado por pnpm → tsx/next → node). */
export const MEMORY_PROFILES: readonly MemoryProfilePreset[] = [
  { value: 'off', label: 'Desligado (padrão)' },
  { value: 'low', label: 'Baixo — heap 256 MB · semi-espaço 8 MB', heapMb: 256, semiSpaceMb: 8 },
  {
    value: 'medium',
    label: 'Médio — heap 512 MB · semi-espaço 16 MB',
    heapMb: 512,
    semiSpaceMb: 16,
  },
  {
    value: 'high',
    label: 'Alto — heap 1024 MB · semi-espaço 32 MB',
    heapMb: 1024,
    semiSpaceMb: 32,
  },
  { value: 'custom', label: 'Personalizado' },
];

export function buildNodeOptions(heapMb: number | null, semiSpaceMb: number | null): string {
  const parts: string[] = [];
  if (heapMb !== null && Number.isFinite(heapMb) && heapMb > 0) {
    parts.push(`--max-old-space-size=${Math.round(heapMb)}`);
  }
  if (semiSpaceMb !== null && Number.isFinite(semiSpaceMb) && semiSpaceMb > 0) {
    parts.push(`--max-semi-space-size=${Math.round(semiSpaceMb)}`);
  }
  return parts.join(' ');
}

export interface MemoryProfileState {
  profile: MemoryProfile;
  heapMb: number | null;
  semiSpaceMb: number | null;
}

function findNodeOptionsRow(state: ProjectFormState): EnvironmentRow | undefined {
  return state.environment.find((row) => row.key.trim().toUpperCase() === 'NODE_OPTIONS');
}

/** Deriva o preset a partir do NODE_OPTIONS atual (não sobrescreve valores manuais). */
export function memoryProfileFromState(state: ProjectFormState): MemoryProfileState {
  const row = findNodeOptionsRow(state);
  if (!row || row.value.trim() === '') {
    return { profile: 'off', heapMb: null, semiSpaceMb: null };
  }
  const heap = /--max-old-space-size=(\d+)/.exec(row.value)?.[1];
  const semi = /--max-semi-space-size=(\d+)/.exec(row.value)?.[1];
  const heapMb = heap ? Number(heap) : null;
  const semiSpaceMb = semi ? Number(semi) : null;
  const preset = MEMORY_PROFILES.find(
    (item) =>
      item.value !== 'off' &&
      item.value !== 'custom' &&
      item.heapMb === heapMb &&
      item.semiSpaceMb === semiSpaceMb,
  );
  return { profile: preset?.value ?? 'custom', heapMb, semiSpaceMb };
}

/** Reescreve apenas a linha NODE_OPTIONS, preservando as demais variáveis. */
export function applyMemoryProfile(
  state: ProjectFormState,
  profile: MemoryProfile,
  custom?: { heapMb: number | null; semiSpaceMb: number | null },
): ProjectFormState {
  const environment = state.environment.filter(
    (row) => row.key.trim().toUpperCase() !== 'NODE_OPTIONS',
  );

  if (profile === 'off') {
    return { ...state, environment };
  }

  const preset = MEMORY_PROFILES.find((item) => item.value === profile);
  const heapMb = profile === 'custom' ? (custom?.heapMb ?? 256) : (preset?.heapMb ?? 256);
  const semiSpaceMb =
    profile === 'custom' ? (custom?.semiSpaceMb ?? 8) : (preset?.semiSpaceMb ?? 8);
  const value = buildNodeOptions(heapMb, semiSpaceMb);

  if (value === '') {
    return { ...state, environment };
  }

  return { ...state, environment: [...environment, { key: 'NODE_OPTIONS', value }] };
}

function buildSharedBody(state: ProjectFormState): Record<string, unknown> {
  const port = state.port.trim() === '' ? null : parseInteger(state.port, Number.NaN);
  return {
    name: state.name.trim(),
    description: state.description.trim() === '' ? null : state.description.trim(),
    workingDirectory: state.directory.trim(),
    groupId: state.groupId.trim() === '' ? null : state.groupId.trim(),
    launchMode: state.launchMode,
    serveMode: state.serveMode,
    outputDir: state.outputDir.trim() === '' ? null : state.outputDir.trim(),
    environment: buildEnvironment(state.environment),
    dependsOn: state.dependsOn.map((dependency) => ({
      projectId: dependency.projectId,
      waitFor: dependency.waitFor,
    })),
    dependencyTimeoutMs: parseInteger(state.dependencyTimeoutMs, 60_000),
    port,
    portSource: port === null ? 'none' : 'fixed',
    enabled: state.enabled,
    startOnBoot: state.startOnBoot,
    startupOrder: parseInteger(state.startupOrder, 0),
    restartPolicy: {
      enabled: state.restartEnabled,
      maxRetries: parseInteger(state.maxRetries, 5),
      baseDelayMs: parseInteger(state.baseDelayMs, 2_000),
      maxDelayMs: parseInteger(state.maxDelayMs, 30_000),
      jitterRatio: 0,
      stableAfterMs: parseInteger(state.stableAfterMs, 60_000),
      resetRetriesAfterStable: true,
    },
    healthCheck: {
      enabled: state.healthEnabled,
      type: state.healthType,
      target: state.healthTarget.trim(),
      expectedStatus: 200,
      intervalMs: parseInteger(state.healthIntervalMs, 30_000),
      timeoutMs: parseInteger(state.healthTimeoutMs, 5_000),
      failureThreshold: parseInteger(state.healthFailureThreshold, 3),
      restartOnUnhealthy: state.healthRestartOnUnhealthy,
      unhealthyRestartCooldownMs: 60_000,
    },
    shutdown: { gracefulTimeoutMs: parseInteger(state.gracefulTimeoutMs, 10_000) },
  };
}

export function buildCreateBody(state: ProjectFormState): Record<string, unknown> {
  return {
    ...buildSharedBody(state),
    runtime: {
      executable: state.executable.trim(),
      args: parseArgsText(state.argsText),
    },
  };
}

export function buildImportBody(state: ProjectFormState): Record<string, unknown> {
  return {
    ...buildSharedBody(state),
    script: state.script.trim(),
    packageManager: state.packageManager,
  };
}

export function buildUpdateBody(state: ProjectFormState): Record<string, unknown> {
  return buildCreateBody(state);
}

function isAbsoluteDirectory(directory: string): boolean {
  return (
    WINDOWS_ABSOLUTE.test(directory) ||
    UNC_ABSOLUTE.test(directory) ||
    POSIX_ABSOLUTE.test(directory)
  );
}

export function validateBasics(state: ProjectFormState): string[] {
  const errors: string[] = [];
  if (state.name.trim() === '') {
    errors.push('Informe um nome para o projeto.');
  } else if (state.name.trim().length > 120) {
    errors.push('O nome deve ter no máximo 120 caracteres.');
  }
  if (!isAbsoluteDirectory(state.directory.trim())) {
    errors.push('O diretório precisa ser um caminho absoluto (ex.: C:\\dev\\api).');
  }
  return errors;
}

export function validateCommand(state: ProjectFormState): string[] {
  const errors: string[] = [];

  if (state.mode === 'script') {
    if (!SCRIPT_NAME.test(state.script.trim())) {
      errors.push('Informe um script válido do package.json.');
    }
  } else if (state.executable.trim() === '') {
    errors.push('Informe o executável do projeto.');
  }

  if (state.port.trim() !== '') {
    const port = Number.parseInt(state.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      errors.push('A porta deve estar entre 1 e 65535.');
    }
  }

  const seenKeys = new Set<string>();
  for (const row of state.environment) {
    const key = row.key.trim();
    if (key === '') {
      continue;
    }
    if (!ENV_KEY.test(key)) {
      errors.push(`Nome de variável inválido: ${key}`);
    }
    if (seenKeys.has(key)) {
      errors.push(`Variável duplicada: ${key}`);
    }
    seenKeys.add(key);
  }

  return errors;
}

export function validateAdvanced(state: ProjectFormState): string[] {
  const errors: string[] = [];

  const startupOrder = Number.parseInt(state.startupOrder, 10);
  if (!Number.isInteger(startupOrder) || startupOrder < 0) {
    errors.push('A ordem de inicialização deve ser um inteiro >= 0.');
  }

  const baseDelay = Number.parseInt(state.baseDelayMs, 10);
  const maxDelay = Number.parseInt(state.maxDelayMs, 10);
  if (!Number.isInteger(baseDelay) || baseDelay < 100) {
    errors.push('baseDelayMs deve ser >= 100.');
  }
  if (!Number.isInteger(maxDelay) || maxDelay < baseDelay) {
    errors.push('maxDelayMs deve ser >= baseDelayMs.');
  }
  if (!Number.isInteger(Number.parseInt(state.maxRetries, 10))) {
    errors.push('maxRetries deve ser um inteiro.');
  }
  if (!Number.isInteger(Number.parseInt(state.stableAfterMs, 10))) {
    errors.push('stableAfterMs deve ser um inteiro.');
  }

  const gracefulTimeout = Number.parseInt(state.gracefulTimeoutMs, 10);
  if (!Number.isInteger(gracefulTimeout) || gracefulTimeout < 100 || gracefulTimeout > 300_000) {
    errors.push('gracefulTimeoutMs deve estar entre 100 e 300000.');
  }

  const dependencyTimeout = Number.parseInt(state.dependencyTimeoutMs, 10);
  if (
    !Number.isInteger(dependencyTimeout) ||
    dependencyTimeout < 1_000 ||
    dependencyTimeout > 600_000
  ) {
    errors.push('O timeout de dependência deve estar entre 1000 e 600000 ms.');
  }

  if (state.healthEnabled) {
    const target = state.healthTarget.trim();
    if (target === '') {
      errors.push('Informe o alvo do health check.');
    } else if (state.healthType === 'http' && !/^https?:\/\//i.test(target)) {
      errors.push('Health check HTTP exige URL começando com http:// ou https://.');
    } else if (state.healthType === 'tcp' && !/^[^\s:]+:\d{1,5}$/.test(target)) {
      errors.push('Health check TCP exige host:porta.');
    }
    const interval = Number.parseInt(state.healthIntervalMs, 10);
    const timeout = Number.parseInt(state.healthTimeoutMs, 10);
    if (Number.isInteger(interval) && Number.isInteger(timeout) && timeout > interval) {
      errors.push('O timeout do health check deve ser menor ou igual ao intervalo.');
    }
    if (!Number.isInteger(Number.parseInt(state.healthFailureThreshold, 10))) {
      errors.push('failureThreshold deve ser um inteiro.');
    }
  }

  return errors;
}

export function validateFormState(state: ProjectFormState): string[] {
  return [...validateBasics(state), ...validateCommand(state), ...validateAdvanced(state)];
}

export function validateStep(state: ProjectFormState, step: number): string[] {
  if (step <= 0) {
    return validateBasics(state);
  }
  if (step === 1) {
    return validateCommand(state);
  }
  return validateFormState(state);
}
