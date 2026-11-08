import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectConfig } from '@lsm/contracts';
import { scanProjectRoot } from '@lsm/platform-win';

export interface LaunchResolution {
  mode: 'direct' | 'wrapper';
  executable: string;
  args: string[];
  cwd: string;
  reason: string | null;
  /** Processos de wrapper evitados (pnpm, cmd.exe e CLI do tsx). */
  skippedProcesses: number;
  script: string | null;
  appDirectory: string | null;
  extraEnv: Record<string, string>;
}

const SHELL_META = /[&|;<>`]|\$\(|\r|\n/;
const RUNNER_PATTERN = /^(?:pnpm|npm|yarn|bun)\.(?:c?js|mjs)$/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function wrapper(config: ProjectConfig, reason: string): LaunchResolution {
  return {
    mode: 'wrapper',
    executable: config.runtime.executable,
    args: [...config.runtime.args],
    cwd: config.workingDirectory,
    reason,
    skippedProcesses: 0,
    script: null,
    appDirectory: null,
    extraEnv: {},
  };
}

function readPackageJson(directory: string): { scripts?: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as { scripts?: Record<string, unknown> })
      : null;
  } catch {
    return null;
  }
}

function scriptCommand(directory: string, script: string): string | null {
  const packageJson = readPackageJson(directory);
  const scripts = packageJson?.scripts;
  if (scripts === null || scripts === undefined) {
    return null;
  }
  const command = scripts[script];
  return typeof command === 'string' && command.trim() !== '' ? command.trim() : null;
}

/** Descobre a pasta do pacote a partir de `--filter <pkg>` em um workspace. */
export function findPackageDirectory(root: string, packageName: string): string | null {
  try {
    const scan = scanProjectRoot(root);
    const match = scan.projects.find((project) => project.packageName === packageName);
    return match?.directory ?? null;
  } catch {
    return null;
  }
}

export interface RunnerInvocation {
  script: string;
  appDirectory: string | null;
  filtered: boolean;
}

/** Interpreta `pnpm run x`, `pnpm --filter pkg x` e variações. */
export function parseRunnerInvocation(
  config: ProjectConfig,
  args: readonly string[],
): RunnerInvocation | null {
  const runnerIndex = args.findIndex((arg) => RUNNER_PATTERN.test(basename(arg)));
  if (runnerIndex === -1) {
    return null;
  }

  const rest = args.slice(runnerIndex + 1);
  let packageName: string | null = null;
  let index = 0;

  while (index < rest.length) {
    const token = rest[index] as string;
    if (token === '--filter' || token === '-F' || token === '--workspace') {
      packageName = rest[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token.startsWith('--filter=')) {
      packageName = token.slice('--filter='.length);
      index += 1;
      continue;
    }
    if (token === 'run' || token === 'run-script') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    return {
      script: token,
      appDirectory:
        packageName === null
          ? config.workingDirectory
          : findPackageDirectory(config.workingDirectory, packageName),
      filtered: packageName !== null,
    };
  }

  return null;
}

function splitCommand(command: string): string[] | null {
  if (SHELL_META.test(command)) {
    return null;
  }
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g);
  if (tokens === null) {
    return null;
  }
  return tokens.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

function resolveNodeBinaries(appDirectory: string): {
  next: string | null;
  vite: string | null;
  tsx: boolean;
} {
  const nodeModules = join(appDirectory, 'node_modules');
  const next = join(nodeModules, 'next', 'dist', 'bin', 'next');
  const vite = join(nodeModules, 'vite', 'bin', 'vite.js');
  return {
    next: existsSync(next) ? next : null,
    vite: existsSync(vite) ? vite : null,
    tsx: existsSync(join(nodeModules, 'tsx')),
  };
}

function pickDistEntry(appDirectory: string, sourceEntry: string): string | null {
  const relative = sourceEntry.replace(/\\/g, '/');
  if (!relative.startsWith('src/') || extname(relative) !== '.ts') {
    return null;
  }
  const distEntry = join(
    appDirectory,
    'dist',
    relative.slice('src/'.length).replace(/\.ts$/, '.js'),
  );
  return existsSync(distEntry) ? distEntry : null;
}

/**
 * Tenta transformar um projeto lançado por package manager em um spawn direto
 * de `node`, eliminando pnpm, cmd.exe e o CLI do tsx/next/vite.
 * Qualquer ambiguidade resulta em `wrapper` (nunca executa shell).
 */
export function resolveLaunch(config: ProjectConfig): LaunchResolution {
  if (config.launchMode === 'wrapper') {
    return wrapper(config, 'modo "com wrapper" configurado');
  }

  const invocation = parseRunnerInvocation(config, config.runtime.args);
  if (invocation === null) {
    return wrapper(config, 'runtime não é um script de package manager');
  }
  const appDirectory = invocation.appDirectory;
  if (appDirectory === null) {
    return wrapper(config, 'pacote do filtro não encontrado no workspace');
  }

  const command = scriptCommand(appDirectory, invocation.script);
  if (command === null) {
    return wrapper(config, `script "${invocation.script}" não encontrado no package.json`);
  }

  const tokens = splitCommand(command);
  if (tokens === null || tokens.length === 0) {
    return wrapper(config, 'script usa recursos de shell; mantendo o wrapper');
  }

  const extraEnv: Record<string, string> = {};
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (token === 'cross-env' || token === 'cross-env-shell') {
      index += 1;
      while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] as string)) {
        const [key, ...value] = (tokens[index] as string).split('=');
        if (key) {
          extraEnv[key] = value.join('=');
        }
        index += 1;
      }
      continue;
    }
    if (ENV_ASSIGNMENT.test(token)) {
      const [key, ...value] = token.split('=');
      if (key) {
        extraEnv[key] = value.join('=');
      }
      index += 1;
      continue;
    }
    break;
  }

  const bin = tokens[index];
  const rest = tokens.slice(index + 1);
  if (bin === undefined) {
    return wrapper(config, 'script vazio');
  }
  const nodeExecutable = config.runtime.executable;
  const binaries = resolveNodeBinaries(appDirectory);

  const build = (
    executable: string,
    args: string[],
    skippedProcesses: number,
    note: string,
  ): LaunchResolution => ({
    mode: 'direct',
    executable,
    args,
    cwd: appDirectory,
    reason: note,
    skippedProcesses,
    script: invocation.script,
    appDirectory,
    extraEnv,
  });

  if (bin === 'node') {
    const entry = rest[0];
    if (entry === undefined || entry.startsWith('-')) {
      return wrapper(config, 'script node sem arquivo de entrada explícito');
    }
    const absolute = isAbsolute(entry) ? entry : resolve(appDirectory, entry);
    if (!existsSync(absolute)) {
      return wrapper(config, `arquivo não encontrado: ${entry}`);
    }
    return build(nodeExecutable, rest, 2, 'node direto (sem pnpm/cmd)');
  }

  if (bin === 'tsx') {
    const watching = rest[0] === 'watch';
    if (watching && config.launchMode !== 'direct') {
      return wrapper(
        config,
        'script usa tsx watch; escolha "execução direta" para rodar sem watcher',
      );
    }
    const withoutWatch = watching ? rest.slice(1) : rest;
    const entry = withoutWatch[0];
    if (entry === undefined || entry.startsWith('-')) {
      return wrapper(config, 'tsx sem arquivo de entrada explícito');
    }
    const absolute = isAbsolute(entry) ? entry : resolve(appDirectory, entry);
    if (!existsSync(absolute)) {
      return wrapper(config, `arquivo não encontrado: ${entry}`);
    }
    const distEntry = pickDistEntry(appDirectory, entry);
    if (distEntry !== null) {
      return build(
        nodeExecutable,
        [distEntry, ...withoutWatch.slice(1)],
        3,
        'node direto no build (sem pnpm/tsx)',
      );
    }
    if (!binaries.tsx) {
      return wrapper(config, 'pacote tsx não encontrado no projeto');
    }
    return build(
      nodeExecutable,
      ['--import', 'tsx', absolute, ...withoutWatch.slice(1)],
      3,
      'node --import tsx (sem pnpm/CLI do tsx)',
    );
  }

  if (bin === 'next') {
    if (binaries.next === null) {
      return wrapper(config, 'binário do next não encontrado');
    }
    return build(nodeExecutable, [binaries.next, ...rest], 2, 'next direto (sem pnpm/cmd)');
  }

  if (bin === 'vite') {
    if (binaries.vite === null) {
      return wrapper(config, 'binário do vite não encontrado');
    }
    return build(nodeExecutable, [binaries.vite, ...rest], 2, 'vite direto (sem pnpm/cmd)');
  }

  return wrapper(config, `comando "${bin}" não suportado para execução direta`);
}

/** Comando one-shot para o build (mantém o package manager por confiabilidade). */
export function resolveBuildCommand(config: ProjectConfig): {
  executable: string;
  args: string[];
  cwd: string;
  appDirectory: string;
} | null {
  const invocation = parseRunnerInvocation(config, config.runtime.args);
  if (invocation === null) {
    return null;
  }
  const appDirectory = invocation.appDirectory;
  if (appDirectory === null || scriptCommand(appDirectory, 'build') === null) {
    return null;
  }

  const args = config.runtime.args;
  const runnerIndex = args.findIndex((arg) => RUNNER_PATTERN.test(basename(arg)));
  const prefix = args.slice(0, runnerIndex + 1);
  const filterArgs: string[] = [];
  for (let index = runnerIndex + 1; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--filter' || token === '-F' || token === '--workspace') {
      filterArgs.push(token, args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (token.startsWith('--filter=')) {
      filterArgs.push(token);
      continue;
    }
    if (token === 'run' || token === 'run-script') {
      continue;
    }
    break; // nome do script original
  }

  return {
    executable: config.runtime.executable,
    args: [...prefix, ...filterArgs, 'build'],
    cwd: config.workingDirectory,
    appDirectory,
  };
}

/** Diretório raiz do conteúdo estático (absoluto). */
export function resolveStaticRoot(config: ProjectConfig): string | null {
  const invocation = parseRunnerInvocation(config, config.runtime.args);
  const appDirectory = invocation?.appDirectory ?? config.workingDirectory;
  const configured = config.outputDir;

  const candidates: string[] = [];
  if (configured !== null && configured.trim() !== '') {
    candidates.push(isAbsolute(configured) ? configured : resolve(appDirectory, configured));
  }
  for (const name of ['dist', 'build', 'out']) {
    candidates.push(join(appDirectory, name));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}
