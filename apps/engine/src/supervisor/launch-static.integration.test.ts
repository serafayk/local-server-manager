import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

async function boot(): Promise<{ engine: Engine; dataDir: string }> {
  const dataDir = createTempDir('lsm-launch-int-');
  const engine = createEngine({ dataDir, singleInstance: false, logger });
  await engine.start();
  cleanups.push(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return { engine, dataDir };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

function write(root: string, relative: string, content = ''): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

describe('execução direta e modo estático', () => {
  it('inicia sem pnpm e expõe a prévia direta', async () => {
    const { engine } = await boot();
    const appDir = createTempDir('lsm-direct-app-');
    cleanups.unshift(async () => removeTempDir(appDir));

    write(appDir, 'server.mjs', 'setInterval(() => {}, 1000);');
    write(
      appDir,
      'package.json',
      JSON.stringify({ name: '@t/app', scripts: { start: 'node server.mjs' } }),
    );
    write(appDir, 'pnpm.js', '');

    const config = engine.projects.createProject({
      name: 'direto',
      workingDirectory: appDir,
      runtime: {
        executable: process.execPath,
        args: [join(appDir, 'pnpm.js'), 'run', 'start'],
      },
      launchMode: 'auto',
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    const preview = engine.projects.launchPreview(config.id);
    expect(preview.mode).toBe('direct');
    expect(preview.args).toEqual(['server.mjs']);

    await engine.supervisor.startProject(config.id);
    const status = engine.supervisor.getSnapshot(config.id);
    expect(status.status).toBe('RUNNING');
    expect(status.pid).toBeGreaterThan(0);

    await engine.supervisor.stopProject(config.id);
  });

  it('serve arquivos estáticos sem processo filho e para ao final', async () => {
    const { engine } = await boot();
    const appDir = createTempDir('lsm-static-app-');
    cleanups.unshift(async () => removeTempDir(appDir));

    write(appDir, 'dist/index.html', '<html><body>hello-static</body></html>');
    write(appDir, 'dist/assets/app.js', 'console.log(1);');
    write(
      appDir,
      'package.json',
      JSON.stringify({ name: '@t/web', scripts: { start: 'node server.js' } }),
    );

    const port = await freePort();
    const config = engine.projects.createProject({
      name: 'estatico',
      workingDirectory: appDir,
      runtime: { executable: process.execPath, args: ['server.js'] },
      launchMode: 'wrapper',
      serveMode: 'static',
      port,
      portSource: 'fixed',
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    await engine.supervisor.startProject(config.id);
    const status = engine.supervisor.getSnapshot(config.id);
    expect(status.status).toBe('RUNNING');
    expect(status.pid).toBeNull();

    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('hello-static');

    const fallback = await fetch(`http://127.0.0.1:${port}/qualquer-rota`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain('hello-static');

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`);
    expect([403, 404]).toContain(traversal.status);

    await engine.supervisor.stopProject(config.id);
    expect(engine.supervisor.getSnapshot(config.id).status).toBe('STOPPED');
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
