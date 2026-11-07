import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, normalize } from 'node:path';
import { AppError } from '@lsm/shared';

export interface ResolveExecutableOptions {
  cwd?: string;
  pathEnv?: string;
  /** Extensões executáveis do Windows, na ordem de preferência. */
  pathext?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedExecutable {
  /** Caminho absoluto do arquivo executável. */
  executable: string;
  /** Verdadeiro quando foi localizado via PATH, não por caminho explícito. */
  viaPath: boolean;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ABSOLUTE = /^\//;

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function parsePathList(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
}

function parsePathExt(value: string | undefined): string[] {
  return parsePathList(value, 'win32').map((ext) =>
    ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
}

function candidatesForFile(file: string, platform: NodeJS.Platform, pathext: string[]): string[] {
  if (!isWindows(platform)) {
    return [file];
  }
  const withExtension = pathext.map((ext) => `${file}${ext}`);
  if (extname(file) !== '') {
    return [file, ...withExtension];
  }
  return [...withExtension, file];
}

/**
 * Resolve um executável para caminho absoluto sem executar nada e sem shell.
 *
 * Regras:
 * - caminho absoluto (drive letter, UNC ou `/`): usa direto, tentando PATHEXT
 *   quando não houver extensão;
 * - caminho relativo com separador: resolve a partir de `cwd`;
 * - nome simples: procura no PATH.
 */
export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): ResolvedExecutable {
  const platform = options.platform ?? process.platform;
  const trimmed = command.trim();
  if (trimmed === '') {
    throw new AppError('EXECUTABLE_NOT_FOUND', 'Executável vazio');
  }

  const pathext = parsePathExt(options.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD');
  const absolute =
    (isWindows(platform) && (WINDOWS_ABSOLUTE.test(trimmed) || UNC_ABSOLUTE.test(trimmed))) ||
    (isWindows(platform) && POSIX_ABSOLUTE.test(trimmed)) ||
    isAbsolute(trimmed);

  if (absolute) {
    for (const candidate of candidatesForFile(normalize(trimmed), platform, pathext)) {
      if (isFile(candidate)) {
        return { executable: candidate, viaPath: false };
      }
    }
    throw new AppError('EXECUTABLE_NOT_FOUND', `Executável não encontrado: ${trimmed}`, {
      command: trimmed,
    });
  }

  const cwd = options.cwd ?? process.cwd();
  const hasSeparator = /[\\/]/.test(trimmed);
  if (hasSeparator) {
    const base = normalize(join(cwd, trimmed));
    for (const candidate of candidatesForFile(base, platform, pathext)) {
      if (isFile(candidate)) {
        return { executable: candidate, viaPath: false };
      }
    }
    throw new AppError('EXECUTABLE_NOT_FOUND', `Executável não encontrado em ${base}`, {
      command: trimmed,
      cwd,
    });
  }

  const pathEntries = parsePathList(options.pathEnv ?? process.env.PATH ?? '', platform);
  for (const entry of pathEntries) {
    for (const candidate of candidatesForFile(join(entry, trimmed), platform, pathext)) {
      if (isFile(candidate)) {
        return { executable: candidate, viaPath: true };
      }
    }
  }

  throw new AppError(
    'EXECUTABLE_NOT_FOUND',
    `Executável "${trimmed}" não encontrado no PATH. Configure um caminho absoluto.`,
    { command: trimmed, searchedPaths: pathEntries.length },
  );
}

/**
 * `.cmd`/`.bat` não podem ser executados com shell:false (Node recusa por
 * segurança desde o fix de CVE-2024-27980). Em vez de ligar shell, o Engine
 * resolve o entrypoint JS real — ver ADR-010 e `package-manager.ts`.
 */
export function assertDirectlySpawnable(executable: string): void {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    throw new AppError(
      'EXECUTABLE_REQUIRES_SHELL',
      `"${executable}" é um script de shell do Windows e não pode ser executado com shell desabilitado. ` +
        'Use o executável Node com o entrypoint .js correspondente (ou configure via package manager).',
      { executable },
    );
  }
}

export function pathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ';' : delimiter;
}

export { isFile as fileExists };
