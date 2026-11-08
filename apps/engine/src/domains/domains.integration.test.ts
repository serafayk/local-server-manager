import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

function appDirectory(): string {
  const directory = createTempDir('lsm-domains-app-');
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(join(directory, 'dist', 'index.html'), '<h1>dominio-ok</h1>', 'utf8');
  cleanups.push(async () => removeTempDir(directory));
  return directory;
}

function hostsFile(): string {
  const directory = createTempDir('lsm-domains-hosts-');
  const file = join(directory, 'hosts');
  writeFileSync(file, '127.0.0.1 localhost\r\n', 'utf8');
  cleanups.push(async () => removeTempDir(directory));
  return file;
}

async function bootEngine(): Promise<Engine> {
  const dataDir = createTempDir('lsm-domains-engine-');
  const engine = createEngine({
    dataDir,
    singleInstance: false,
    logger,
    domainPorts: { httpPort: 0, httpsPort: 0 },
    hostsFile: hostsFile(),
  });
  await engine.start();
  cleanups.unshift(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return engine;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.shift();
    if (cleanup) {
      await cleanup();
    }
  }
});

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

function fetchThroughProxy(
  port: number,
  host: string,
  path = '/',
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('domínios locais', () => {
  it('serve um projeto estático por domínio e alias .localhost', async () => {
    const engine = await bootEngine();
    const directory = appDirectory();
    const port = await freePort();

    const project = engine.projects.createProject({
      name: 'site',
      workingDirectory: directory,
      runtime: { executable: process.execPath, args: ['server.js'] },
      serveMode: 'static',
      port,
      portSource: 'fixed',
      shutdown: { gracefulTimeoutMs: 1_000 },
    });
    await engine.supervisor.startProject(project.id);

    const route = await engine.domains.create({ host: 'app.lsm', projectId: project.id });
    expect(route.urls.http).toMatch(/^http:\/\/app\.lsm:\d+$/);
    expect(route.urls.localhost).toContain('app.localhost');
    expect(route.upstreamPort).toBe(port);

    const overview = await engine.domains.overview();
    expect(overview.status.httpPort).toBeGreaterThan(0);
    expect(overview.status.httpsPort).toBeGreaterThan(0);
    expect(overview.status.httpListening).toBe(true);
    expect(overview.status.certificate.exists).toBe(true);
    expect(overview.status.pendingHosts).toEqual(['app.lsm']);

    const viaHost = await fetchThroughProxy(overview.status.httpPort, 'app.lsm');
    expect(viaHost.status).toBe(200);
    expect(viaHost.body).toContain('dominio-ok');

    const viaAlias = await fetchThroughProxy(overview.status.httpPort, 'app.localhost');
    expect(viaAlias.status).toBe(200);
    expect(viaAlias.body).toContain('dominio-ok');

    const unknown = await fetchThroughProxy(overview.status.httpPort, 'outro.lsm');
    expect(unknown.status).toBe(404);
  }, 40_000);

  it('rejeita host inválido, conflito de alias e domínio inexistente', async () => {
    const engine = await bootEngine();
    const directory = appDirectory();
    const project = engine.projects.createProject({
      name: 'api',
      workingDirectory: directory,
      runtime: { executable: process.execPath, args: ['server.js'] },
    });

    await expect(
      engine.domains.create({ host: 'api.example.com', projectId: project.id }),
    ).rejects.toThrowError(/inválida/i);

    await engine.domains.create({ host: 'api.lsm', projectId: project.id });
    await expect(
      engine.domains.create({ host: 'api.localhost', projectId: project.id }),
    ).rejects.toThrowError(/conflita/i);
    await expect(
      engine.domains.create({ host: 'api.lsm', projectId: project.id }),
    ).rejects.toThrowError(/conflita|já existe/i);

    expect(() => engine.domains.delete('inexistente')).toThrowError(/não encontrado/i);
    const routes = engine.domains.list();
    expect(routes).toHaveLength(1);

    engine.domains.delete(routes[0]?.id as string);
    expect(engine.domains.list()).toHaveLength(0);
    const overview = await engine.domains.overview();
    expect(overview.status.pendingHosts).toEqual([]);
  }, 40_000);
});
