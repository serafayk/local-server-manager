import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../tests/helpers';
import { inspectProjectDirectory } from './project-discovery';

const directories: string[] = [];

function setupDir(): string {
  const directory = createTempDir('lsm-discovery-');
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('inspectProjectDirectory', () => {
  it('lê scripts em ordem estável e nome do projeto', () => {
    const directory = setupDir();
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'meu-app',
        scripts: { start: 'node index.js', dev: 'vite', build: 'vite build' },
      }),
      'utf8',
    );

    const inspection = inspectProjectDirectory(directory);
    expect(inspection.hasPackageJson).toBe(true);
    expect(inspection.projectName).toBe('meu-app');
    expect(inspection.scripts.map((script) => script.name)).toEqual(['build', 'dev', 'start']);
    expect(inspection.scripts[1]?.command).toBe('vite');
  });

  it('detecta package manager por lockfile', () => {
    const directory = setupDir();
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'app', scripts: {} }),
      'utf8',
    );
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

    const inspection = inspectProjectDirectory(directory);
    expect(inspection.packageManager.packageManager).toBe('pnpm');
    expect(inspection.packageManager.confirmed).toBe(true);
  });

  it('lida com pasta sem package.json', () => {
    const directory = setupDir();
    const inspection = inspectProjectDirectory(directory);
    expect(inspection.hasPackageJson).toBe(false);
    expect(inspection.scripts).toEqual([]);
    expect(inspection.packageManager.packageManager).toBe('npm');
  });

  it('rejeita package.json inválido', () => {
    const directory = setupDir();
    writeFileSync(join(directory, 'package.json'), '{ nao é json', 'utf8');

    try {
      inspectProjectDirectory(directory);
      throw new Error('esperava PROJECT_INVALID_CONFIG');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PROJECT_INVALID_CONFIG');
    }
  });

  it('rejeita diretório inexistente', () => {
    const directory = join(setupDir(), 'nao-existe');
    expect(() => inspectProjectDirectory(directory)).toThrow(AppError);
  });

  it('ignora entradas de scripts que não são strings', () => {
    const directory = setupDir();
    mkdirSync(join(directory, 'src'));
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'app', scripts: { ok: 'node .', invalido: 42, nulo: null } }),
      'utf8',
    );

    const inspection = inspectProjectDirectory(directory);
    expect(inspection.scripts).toEqual([{ name: 'ok', command: 'node .' }]);
  });
});
