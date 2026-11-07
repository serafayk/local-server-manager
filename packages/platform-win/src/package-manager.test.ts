import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { createTempDir, removeTempDir } from '../../../tests/helpers';
import { detectPackageManager, resolvePackageManagerInvocation } from './package-manager';

const isWindows = process.platform === 'win32';

const SHIM_WITH_JS = [
  '@SETLOCAL',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\lib\\cli.js" %*',
  ') ELSE (',
  '  node  "%~dp0\\lib\\cli.js" %*',
  ')',
].join('\r\n');

const SHIM_WITHOUT_JS = ['@SETLOCAL', 'call "%~dp0\\real-tool.cmd" %*'].join('\r\n');

const NPM_STYLE_SHIM = [
  '@ECHO OFF',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
].join('\r\n');

function withFakePackageManager(shimContent: string, work: (directory: string) => void): void {
  const directory = createTempDir('lsm-pm-');
  try {
    mkdirSync(join(directory, 'lib'), { recursive: true });
    writeFileSync(join(directory, 'lib', 'cli.js'), '// fake entrypoint\n', 'utf8');
    writeFileSync(join(directory, 'npm.cmd'), shimContent, 'utf8');
    work(directory);
  } finally {
    removeTempDir(directory);
  }
}

describe('resolvePackageManagerInvocation', () => {
  it.skipIf(!isWindows)('resolve o entrypoint JS do shim e evita shell', () => {
    withFakePackageManager(SHIM_WITH_JS, (directory) => {
      const invocation = resolvePackageManagerInvocation('npm', 'dev', {
        pathEnv: directory,
        pathext: '.CMD',
      });

      expect(invocation.mode).toBe('node-cli');
      expect(invocation.executable.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(invocation.args[0]?.toLowerCase()).toBe(
        join(directory, 'lib', 'cli.js').toLowerCase(),
      );
      expect(invocation.args.slice(1)).toEqual(['run', 'dev']);
      expect(invocation.warnings).toEqual([]);
    });
  });

  it.skipIf(!isWindows)('prefere npm-cli.js a npm-prefix.js no shim do npm', () => {
    const directory = createTempDir('lsm-pm-npm-');
    try {
      const binDir = join(directory, 'node_modules', 'npm', 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'npm-prefix.js'), '// prefix\n', 'utf8');
      writeFileSync(join(binDir, 'npm-cli.js'), '// cli\n', 'utf8');
      writeFileSync(join(directory, 'npm.cmd'), NPM_STYLE_SHIM, 'utf8');

      const invocation = resolvePackageManagerInvocation('npm', 'dev', {
        pathEnv: directory,
        pathext: '.CMD',
      });

      expect(invocation.mode).toBe('node-cli');
      expect(invocation.args[0]?.toLowerCase()).toBe(join(binDir, 'npm-cli.js').toLowerCase());
      expect(invocation.args.slice(1)).toEqual(['run', 'dev']);
    } finally {
      removeTempDir(directory);
    }
  });

  it.skipIf(!isWindows)('cai para cmd.exe validado quando não há entrypoint JS', () => {
    withFakePackageManager(SHIM_WITHOUT_JS, (directory) => {
      const invocation = resolvePackageManagerInvocation('npm', 'build', {
        pathEnv: directory,
        pathext: '.CMD',
      });

      expect(invocation.mode).toBe('cmd-shim');
      expect(invocation.warnings).toHaveLength(1);
      expect(invocation.args.join(' ')).toContain('" run build"');
    });
  });

  it('rejeita nome de script com caracteres de shell', () => {
    try {
      resolvePackageManagerInvocation('npm', 'dev & del *', { pathEnv: '' });
      throw new Error('esperava VALIDATION_ERROR');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('propaga EXECUTABLE_NOT_FOUND quando o package manager não existe', () => {
    try {
      resolvePackageManagerInvocation('pnpm', 'dev', { pathEnv: '' });
      throw new Error('esperava EXECUTABLE_NOT_FOUND');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('EXECUTABLE_NOT_FOUND');
    }
  });
});

describe('detectPackageManager', () => {
  it('detecta pnpm pelo lockfile', () => {
    const directory = createTempDir('lsm-detect-');
    try {
      writeFileSync(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
      const detected = detectPackageManager(directory);
      expect(detected.packageManager).toBe('pnpm');
      expect(detected.lockfile).toBe('pnpm-lock.yaml');
      expect(detected.confirmed).toBe(true);
    } finally {
      removeTempDir(directory);
    }
  });

  it('usa npm como fallback não confirmado', () => {
    const directory = createTempDir('lsm-detect-');
    try {
      const detected = detectPackageManager(directory);
      expect(detected.packageManager).toBe('npm');
      expect(detected.confirmed).toBe(false);
      expect(detected.lockfile).toBeNull();
    } finally {
      removeTempDir(directory);
    }
  });
});
