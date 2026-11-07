import { AppError } from '@lsm/shared';

export interface ParsedLine {
  command: string;
  args: string[];
  flags: Map<string, string[]>;
}

/**
 * Tokenizador mínimo com suporte a aspas duplas/simples, para caminhos com
 * espaços no Windows (`--dir "C:\Meus Projetos\api"`).
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (const char of line) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }

  if (quote !== null) {
    throw new AppError('VALIDATION_ERROR', 'Aspas não fechadas na linha de comando.');
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

export function parseLine(line: string): ParsedLine | null {
  const tokens = tokenize(line);
  if (tokens.length === 0) {
    return null;
  }

  const command = tokens[0] as string;
  const args: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }
    const equalsIndex = token.indexOf('=');
    if (equalsIndex !== -1) {
      addFlag(flags, token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      addFlag(flags, token.slice(2), next);
      index += 1;
    } else {
      addFlag(flags, token.slice(2), 'true');
    }
  }

  return { command, args, flags };
}

function addFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name) ?? [];
  existing.push(value);
  flags.set(name, existing);
}

export function getFlag(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

export function getFlags(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}

export function hasFlag(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name) && getFlag(flags, name) !== 'false';
}
