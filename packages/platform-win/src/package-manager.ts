import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { AppError } from '@lsm/shared';
import { resolveExecutable, type ResolveExecutableOptions } from './executable-resolver';

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Nome de script npm permitido. Restrito porque o fallback usa cmd.exe. */
const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;

export interface PackageManagerInvocationOptions extends ResolveExecutableOptions {
  nodeExecutable?: string;
}

export interface PackageManagerInvocation {
  executable: string;
  args: string[];
  /**
   * `node-cli`: executa o entrypoint JS com Node (shell:false, preferido).
   * `cmd-shim`: usa cmd.exe apenas para o shim .cmd resolvido, com script
   * validado — último recurso e sempre reportado.
   */
  mode: 'node-cli' | 'cmd-shim' | 'direct';
  packageManager: PackageManager;
  script: string;
  warnings: string[];
}

function findJsEntrypoints(shimPath: string, content: string): string[] {
  const shimDir = dirname(shimPath);
  const tokens = content.match(/[^\s"'()<>|&]+\.(?:cjs|mjs|js)\b/gi) ?? [];
  const results: string[] = [];
  for (const token of tokens) {
    // Shims costumam usar SET "VAR=%~dp0\...\cli.js"; descarta o prefixo VAR=.
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token);
    const raw = assignment?.[2] ?? token;
    const expanded = raw.replace(/%~dp0/gi, `${shimDir}\\`).replace(/%dp0%/gi, `${shimDir}\\`);
    const candidate = isAbsolute(expanded)
      ? normalize(expanded)
      : normalize(join(shimDir, expanded));
    if (!results.includes(candidate) && existsSync(candidate)) {
      results.push(candidate);
    }
  }
  return results;
}

const PREFERRED_ENTRYPOINTS: Readonly<Record<PackageManager, readonly RegExp[]>> = {
  npm: [/^npm-cli\.(?:c?js|mjs)$/i, /^npm\.(?:c?js|mjs)$/i],
  pnpm: [/^pnpm\.(?:c?js|mjs)$/i],
  yarn: [/^yarn\.(?:c?js|mjs)$/i],
  bun: [/^bun\.(?:c?js|mjs)$/i],
};

/**
 * Escolhe o entrypoint correto entre os arquivos referenciados pelo shim.
 * Heurística explícita para não executar `npm-prefix.js` no lugar de
 * `npm-cli.js` (ambos aparecem no mesmo shim).
 */
export function pickPackageManagerEntrypoint(
  candidates: readonly string[],
  packageManager: PackageManager,
): string | null {
  for (const pattern of PREFERRED_ENTRYPOINTS[packageManager]) {
    const match = candidates.find((candidate) => pattern.test(basename(candidate)));
    if (match) {
      return match;
    }
  }
  const cli = candidates.find(
    (candidate) => /cli\.(?:c?js|mjs)$/i.test(basename(candidate)) && !/prefix/i.test(candidate),
  );
  if (cli) {
    return cli;
  }
  return candidates.length > 0 ? (candidates[candidates.length - 1] as string) : null;
}

/**
 * Converte "npm run <script>" em uma execução sem shell sempre que possível.
 *
 * No Windows, `npm`/`pnpm`/`yarn` são shims `.cmd` que Node se recusa a
 * executar com `shell:false`. Em vez de habilitar shell, lemos o shim e
 * executamos o entrypoint `.js` real com o Node (ADR-010).
 */
export function resolvePackageManagerInvocation(
  packageManager: PackageManager,
  script: string,
  options: PackageManagerInvocationOptions = {},
): PackageManagerInvocation {
  if (!SCRIPT_NAME_PATTERN.test(script)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Nome de script inválido: "${script}". Use letras, números, ":", "_", "-" e "." (máx. 64).`,
    );
  }

  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const resolved = resolveExecutable(packageManager, options);
  const extension = extname(resolved.executable).toLowerCase();

  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return {
      executable: nodeExecutable,
      args: [resolved.executable, 'run', script],
      mode: 'node-cli',
      packageManager,
      script,
      warnings: [],
    };
  }

  if (extension === '.cmd' || extension === '.bat') {
    let content = '';
    try {
      content = readFileSync(resolved.executable, 'utf8');
    } catch {
      content = '';
    }
    const entrypoints = findJsEntrypoints(resolved.executable, content);
    const entrypoint = pickPackageManagerEntrypoint(entrypoints, packageManager);

    if (entrypoint !== null) {
      return {
        executable: nodeExecutable,
        args: [entrypoint, 'run', script],
        mode: 'node-cli',
        packageManager,
        script,
        warnings: [],
      };
    }

    return {
      executable:
        process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c', `""${resolved.executable}" run ${script}"`],
      mode: 'cmd-shim',
      packageManager,
      script,
      warnings: [
        `Não foi possível resolver o entrypoint JS de "${resolved.executable}". ` +
          'O shim será executado via cmd.exe com nome de script validado.',
      ],
    };
  }

  return {
    executable: resolved.executable,
    args: ['run', script],
    mode: 'direct',
    packageManager,
    script,
    warnings: [],
  };
}

export interface DetectedPackageManager {
  packageManager: PackageManager;
  lockfile: string | null;
  confirmed: boolean;
}

const LOCKFILES: ReadonlyArray<{ file: string; packageManager: PackageManager }> = [
  { file: 'pnpm-lock.yaml', packageManager: 'pnpm' },
  { file: 'yarn.lock', packageManager: 'yarn' },
  { file: 'bun.lockb', packageManager: 'bun' },
  { file: 'bun.lock', packageManager: 'bun' },
  { file: 'package-lock.json', packageManager: 'npm' },
];

/**
 * Detecção por lockfile é conveniência, nunca certeza
 * (docs/05-PROJECT-CONFIGURATION.md §4).
 */
export function detectPackageManager(directory: string): DetectedPackageManager {
  for (const entry of LOCKFILES) {
    if (existsSync(join(directory, entry.file))) {
      return { packageManager: entry.packageManager, lockfile: entry.file, confirmed: true };
    }
  }
  return { packageManager: 'npm', lockfile: null, confirmed: false };
}
