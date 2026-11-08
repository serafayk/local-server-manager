import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { makeProjectConfig } from '../../../../tests/helpers/project';
import { resolveBuildCommand, resolveLaunch, resolveStaticRoot } from './launch-resolver';

const directories: string[] = [];

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  directories.push(directory);
  return directory;
}

function write(root: string, relative: string, content = ''): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

function projectFor(root: string, script: string, overrides: Record<string, unknown> = {}) {
  write(root, 'pnpm.js', '');
  return makeProjectConfig({
    workingDirectory: root,
    runtime: {
      executable: process.execPath,
      args: [join(root, 'pnpm.js'), 'run', script],
    },
    launchMode: 'auto',
    ...overrides,
  });
}

describe('resolveLaunch', () => {
  it('converte "node arquivo.js" em spawn direto', () => {
    const root = tempDir('lsm-launch-node-');
    write(root, 'server.mjs', 'setInterval(() => {}, 1000);');
    write(
      root,
      'package.json',
      JSON.stringify({ name: '@t/app', scripts: { start: 'node server.mjs' } }),
    );

    const launch = resolveLaunch(projectFor(root, 'start'));
    expect(launch).toMatchObject({
      mode: 'direct',
      executable: process.execPath,
      args: ['server.mjs'],
      cwd: root,
      skippedProcesses: 2,
    });
  });

  it('usa --import tsx quando não há build', () => {
    const root = tempDir('lsm-launch-tsx-');
    write(root, 'src/index.ts', 'setInterval(() => {}, 1000);');
    write(root, 'node_modules/tsx/package.json', '{}');
    write(
      root,
      'package.json',
      JSON.stringify({ name: '@t/app', scripts: { start: 'tsx src/index.ts' } }),
    );

    const launch = resolveLaunch(projectFor(root, 'start'));
    expect(launch.mode).toBe('direct');
    expect(launch.args.slice(0, 2)).toEqual(['--import', 'tsx']);
    expect(launch.args[2]).toContain('index.ts');
  });

  it('mantém tsx watch em auto e remove em execução direta', () => {
    const root = tempDir('lsm-launch-tsx-watch-');
    write(root, 'src/index.ts', 'setInterval(() => {}, 1000);');
    write(root, 'node_modules/tsx/package.json', '{}');
    write(
      root,
      'package.json',
      JSON.stringify({ name: '@t/app', scripts: { dev: 'tsx watch src/index.ts' } }),
    );

    expect(resolveLaunch(projectFor(root, 'dev')).mode).toBe('wrapper');

    const direct = resolveLaunch(projectFor(root, 'dev', { launchMode: 'direct' }));
    expect(direct.mode).toBe('direct');
    expect(direct.args).not.toContain('watch');
    expect(direct.args.slice(0, 2)).toEqual(['--import', 'tsx']);
  });

  it('prefere dist quando o build existe', () => {
    const root = tempDir('lsm-launch-dist-');
    write(root, 'src/index.ts', '');
    write(root, 'dist/index.js', 'setInterval(() => {}, 1000);');
    write(root, 'node_modules/tsx/package.json', '{}');
    write(
      root,
      'package.json',
      JSON.stringify({ name: '@t/app', scripts: { start: 'tsx src/index.ts' } }),
    );

    const launch = resolveLaunch(projectFor(root, 'start'));
    expect(launch.mode).toBe('direct');
    expect(launch.args[0]).toContain(join('dist', 'index.js'));
    expect(launch.args).not.toContain('--import');
  });

  it('resolve next e vite pelo binário local', () => {
    const root = tempDir('lsm-launch-front-');
    write(root, 'node_modules/next/dist/bin/next', '');
    write(root, 'node_modules/vite/bin/vite.js', '');
    write(
      root,
      'package.json',
      JSON.stringify({
        name: '@t/app',
        scripts: { start: 'next dev -p 3000', preview: 'vite preview' },
      }),
    );

    const next = resolveLaunch(projectFor(root, 'start'));
    expect(next.mode).toBe('direct');
    expect(next.args[0]).toContain(join('next', 'dist', 'bin', 'next'));
    expect(next.args.slice(1)).toEqual(['dev', '-p', '3000']);

    const vite = resolveLaunch(projectFor(root, 'preview'));
    expect(vite.mode).toBe('direct');
    expect(vite.args[0]).toContain(join('vite', 'bin', 'vite.js'));
  });

  it('mantém wrapper para comandos compostos ou desconhecidos', () => {
    const root = tempDir('lsm-launch-fallback-');
    write(
      root,
      'package.json',
      JSON.stringify({
        name: '@t/app',
        scripts: { start: 'node a.js && node b.js', other: 'nodemon server.js' },
      }),
    );

    expect(resolveLaunch(projectFor(root, 'start')).mode).toBe('wrapper');
    expect(resolveLaunch(projectFor(root, 'other')).mode).toBe('wrapper');
    expect(resolveLaunch(projectFor(root, 'nao-existe')).mode).toBe('wrapper');
  });

  it('honra launchMode "wrapper"', () => {
    const root = tempDir('lsm-launch-forced-');
    write(root, 'server.mjs', '');
    write(
      root,
      'package.json',
      JSON.stringify({ name: '@t/app', scripts: { start: 'node server.mjs' } }),
    );

    const config = projectFor(root, 'start', { launchMode: 'wrapper' });
    const launch = resolveLaunch(config);
    expect(launch.mode).toBe('wrapper');
    expect(launch.args).toEqual(config.runtime.args);
  });

  it('encontra o pacote do filtro no workspace', () => {
    const root = tempDir('lsm-launch-filter-');
    write(root, 'package.json', JSON.stringify({ name: 'repo', private: true }));
    write(root, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
    write(root, 'apps/api/server.mjs', '');
    write(
      root,
      'apps/api/package.json',
      JSON.stringify({ name: '@t/api', scripts: { start: 'node server.mjs' } }),
    );

    const config = makeProjectConfig({
      workingDirectory: root,
      runtime: {
        executable: process.execPath,
        args: [join(root, 'pnpm.js'), '--filter', '@t/api', 'start'],
      },
      launchMode: 'auto',
    });
    const launch = resolveLaunch(config);
    expect(launch.mode).toBe('direct');
    expect(launch.args).toEqual(['server.mjs']);
    expect(launch.cwd).toBe(join(root, 'apps', 'api'));
  });

  it('resolve build e raiz estática', () => {
    const root = tempDir('lsm-static-root-');
    write(root, 'dist/index.html', '<html></html>');
    write(
      root,
      'package.json',
      JSON.stringify({
        name: '@t/app',
        scripts: { start: 'node server.js', build: 'node build.js' },
      }),
    );
    write(root, 'server.js', '');

    const config = projectFor(root, 'start');
    const build = resolveBuildCommand(config);
    expect(build?.args.slice(-1)).toEqual(['build']);
    expect(build?.cwd).toBe(root);

    expect(resolveStaticRoot(config)).toBe(join(root, 'dist'));
  });
});
