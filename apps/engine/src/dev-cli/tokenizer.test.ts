import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { getFlag, getFlags, hasFlag, parseLine, tokenize } from './tokenizer';

describe('tokenize', () => {
  it('separa por espaços', () => {
    expect(tokenize('projects list')).toEqual(['projects', 'list']);
  });

  it('preserva caminhos com espaço entre aspas duplas', () => {
    expect(tokenize('projects add --dir "C:\\Meus Projetos\\api"')).toEqual([
      'projects',
      'add',
      '--dir',
      'C:\\Meus Projetos\\api',
    ]);
  });

  it('aceita aspas simples e valor vazio', () => {
    expect(tokenize("logs 'meu projeto' --arg ''")).toEqual(['logs', 'meu projeto', '--arg', '']);
  });

  it('rejeita aspas não fechadas', () => {
    expect(() => tokenize('logs "abc')).toThrow(AppError);
  });
});

describe('parseLine', () => {
  it('interpreta flags com valor e repetidas', () => {
    const parsed = parseLine('projects add --name API --arg a --arg "b c" --boot');
    expect(parsed).not.toBeNull();
    expect(parsed?.command).toBe('projects');
    expect(parsed?.args).toEqual(['add']);
    expect(getFlag(parsed!.flags, 'name')).toBe('API');
    expect(getFlags(parsed!.flags, 'arg')).toEqual(['a', 'b c']);
    expect(hasFlag(parsed!.flags, 'boot')).toBe(true);
  });

  it('interpreta --flag=valor', () => {
    const parsed = parseLine('projects add --name=API --port=3000');
    expect(getFlag(parsed!.flags, 'name')).toBe('API');
    expect(getFlag(parsed!.flags, 'port')).toBe('3000');
  });

  it('retorna null para linha vazia', () => {
    expect(parseLine('   ')).toBeNull();
  });
});
