import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { createTempDir, removeTempDir } from '../../../tests/helpers';
import { assertDirectlySpawnable, resolveExecutable } from './executable-resolver';

const isWindows = process.platform === 'win32';

function expectCode(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Esperava erro ${code}`);
}

describe('resolveExecutable', () => {
  it('aceita caminho absoluto existente', () => {
    const resolved = resolveExecutable(process.execPath);
    expect(resolved.executable.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(resolved.viaPath).toBe(false);
  });

  it('falha com EXECUTABLE_NOT_FOUND para caminho absoluto inexistente', () => {
    expectCode(
      () => resolveExecutable('C:\\diretorio-que-nao-existe\\nope.exe'),
      'EXECUTABLE_NOT_FOUND',
    );
  });

  it('encontra node no PATH', () => {
    const resolved = resolveExecutable('node');
    expect(resolved.viaPath).toBe(true);
    expect(resolved.executable).toMatch(/node(\.exe)?$/i);
  });

  it('falha quando o comando não existe no PATH', () => {
    expectCode(
      () => resolveExecutable('binario-inexistente-lsm', { pathEnv: '' }),
      'EXECUTABLE_NOT_FOUND',
    );
  });

  it.skipIf(!isWindows)('resolve caminho relativo usando o cwd', () => {
    const directory = createTempDir('lsm-resolver-');
    try {
      writeFileSync(join(directory, 'tool.cmd'), '@echo off\r\n', 'utf8');
      const resolved = resolveExecutable('.\\tool', { cwd: directory });
      expect(resolved.executable.toLowerCase()).toBe(join(directory, 'tool.cmd').toLowerCase());
    } finally {
      removeTempDir(directory);
    }
  });

  it.skipIf(!isWindows)('encontra executável em PATH customizado', () => {
    const directory = createTempDir('lsm-path-');
    try {
      writeFileSync(join(directory, 'my-tool.exe'), 'fake', 'utf8');
      const resolved = resolveExecutable('my-tool', { pathEnv: directory });
      expect(resolved.executable.toLowerCase()).toContain('my-tool.exe');
      expect(resolved.viaPath).toBe(true);
    } finally {
      removeTempDir(directory);
    }
  });
});

describe('assertDirectlySpawnable', () => {
  it.skipIf(!isWindows)('recusa .cmd e .bat com código específico', () => {
    expectCode(() => assertDirectlySpawnable('C:\\tools\\npm.cmd'), 'EXECUTABLE_REQUIRES_SHELL');
    expectCode(() => assertDirectlySpawnable('C:\\tools\\run.bat'), 'EXECUTABLE_REQUIRES_SHELL');
  });

  it('aceita binários comuns', () => {
    expect(() => assertDirectlySpawnable(process.execPath)).not.toThrow();
  });
});
