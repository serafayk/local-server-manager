import { createServer, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectConfig } from '@lsm/contracts';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  createTempDir,
  fixturePath,
  removeTempDir,
  waitFor,
} from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const silentLogger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];
const servers: Server[] = [];
let counter = 0;

async function bootEngine(): Promise<Engine> {
  const dataDir = createTempDir('lsm-mon-');
  const engine = createEngine({ dataDir, singleInstance: false, logger: silentLogger });
  await engine.start();
  cleanups.push(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return engine;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('sem endereço'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function addProject(engine: Engine, overrides: Record<string, unknown> = {}): ProjectConfig {
  counter += 1;
  return engine.projects.createProject({
    name: `mon-${counter}-${Date.now()}`,
    workingDirectory: FIXTURES_DIR,
    runtime: { executable: process.execPath, args: [fixturePath('http-server.mjs')] },
    shutdown: { gracefulTimeoutMs: 1_000 },
    ...overrides,
  });
}

function healthOf(engine: Engine, projectId: string) {
  return engine.supervisor.getSnapshot(projectId).health;
}

describe('Health check com processos reais', () => {
  it('marca HEALTHY quando o endpoint responde o status esperado', async () => {
    const engine = await bootEngine();
    const port = await reservePort();
    const project = addProject(engine, {
      environment: { PORT: String(port) },
      port,
      portSource: 'fixed',
      healthCheck: {
        enabled: true,
        type: 'http',
        target: `http://127.0.0.1:${port}/health`,
        intervalMs: 1000,
        timeoutMs: 1_000,
        failureThreshold: 1,
      },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => healthOf(engine, project.id) === 'HEALTHY', {
      timeoutMs: 10_000,
      description: 'health HEALTHY',
    });

    const events = engine.projects.listEvents({
      projectId: project.id,
      eventType: 'project.health.changed',
    });
    expect(events.length).toBeGreaterThan(0);
    await engine.supervisor.stopProject(project.id);
  });

  it('marca UNHEALTHY e reinicia com cooldown', async () => {
    const engine = await bootEngine();
    const deadPort = await reservePort();
    const project = addProject(engine, {
      healthCheck: {
        enabled: true,
        type: 'http',
        target: `http://127.0.0.1:${deadPort}/health`,
        intervalMs: 1000,
        timeoutMs: 300,
        failureThreshold: 1,
        restartOnUnhealthy: true,
        unhealthyRestartCooldownMs: 10_000,
      },
    });

    await engine.supervisor.startProject(project.id);
    const firstInstance = engine.supervisor.getSnapshot(project.id).instanceId;

    await waitFor(() => healthOf(engine, project.id) === 'UNHEALTHY', {
      timeoutMs: 10_000,
      description: 'health UNHEALTHY',
    });
    await waitFor(() => engine.supervisor.getSnapshot(project.id).instanceId !== firstInstance, {
      timeoutMs: 15_000,
      description: 'restart por health check',
    });

    const secondInstance = engine.supervisor.getSnapshot(project.id).instanceId;
    await delay(1_500);
    expect(engine.supervisor.getSnapshot(project.id).instanceId).toBe(secondInstance);

    await engine.supervisor.stopProject(project.id);
  });
});

describe('Conflito de porta no start', () => {
  it('detecta a porta ocupada sem bloquear o start nem matar o ocupante', async () => {
    const engine = await bootEngine();
    const occupied = await reservePort();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(occupied, '127.0.0.1', () => resolve()));

    const project = addProject(engine, {
      runtime: { executable: process.execPath, args: [fixturePath('args-echo.mjs')] },
      environment: { FOO: 'bar' },
      port: occupied,
      portSource: 'fixed',
    });

    await engine.supervisor.startProject(project.id);

    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.status).toBe('RUNNING');
    expect(snapshot.portInUse).toBe(true);

    const events = engine.projects.listEvents({
      projectId: project.id,
      eventType: 'project.port.conflict',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ port: occupied });

    await engine.supervisor.stopProject(project.id);
  });
});
