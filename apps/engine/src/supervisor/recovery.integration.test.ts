import { join } from 'node:path';
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
let counter = 0;

async function bootEngine(): Promise<Engine> {
  const dataDir = createTempDir('lsm-rec-');
  const engine = createEngine({ dataDir, singleInstance: false, logger: silentLogger });
  await engine.start();
  cleanups.push(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return engine;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

function addProject(
  engine: Engine,
  fixture: string,
  overrides: Record<string, unknown> = {},
): ProjectConfig {
  counter += 1;
  return engine.projects.createProject({
    name: `rec-${counter}-${Date.now()}`,
    workingDirectory: FIXTURES_DIR,
    runtime: { executable: process.execPath, args: [fixturePath(fixture)] },
    shutdown: { gracefulTimeoutMs: 1_000 },
    ...overrides,
  });
}

function statusOf(engine: Engine, projectId: string): string {
  return engine.supervisor.getSnapshot(projectId).status;
}

describe('Recovery — reinício automático', () => {
  it('reinicia após crash e registra o ciclo', async () => {
    const engine = await bootEngine();
    const markerDir = createTempDir('lsm-marker-');
    cleanups.push(async () => removeTempDir(markerDir));
    const marker = join(markerDir, 'first-run.marker');

    const project = addProject(engine, 'crash-once.mjs', {
      environment: { MARKER_FILE: marker },
      restartPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 150,
        maxDelayMs: 500,
        stableAfterMs: 60_000,
      },
    });

    await engine.supervisor.startProject(project.id);
    const firstInstance = engine.supervisor.getSnapshot(project.id).instanceId;

    await waitFor(
      () => {
        const snapshot = engine.supervisor.getSnapshot(project.id);
        return snapshot.status === 'RUNNING' && snapshot.restartAttempt === 1;
      },
      { timeoutMs: 15_000, description: 'projeto em RUNNING após retry' },
    );

    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.instanceId).not.toBe(firstInstance);
    expect(snapshot.pid).toBeGreaterThan(0);

    const scheduled = engine.projects.listEvents({
      projectId: project.id,
      eventType: 'project.restart.scheduled',
    });
    const started = engine.projects.listEvents({
      projectId: project.id,
      eventType: 'project.restart.started',
    });
    expect(scheduled.length).toBeGreaterThan(0);
    expect(started.length).toBeGreaterThan(0);

    await engine.supervisor.stopProject(project.id);
  });

  it('esgota tentativas e termina em FAILED', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, 'crash-after.mjs', {
      environment: { CRASH_AFTER_MS: '60', EXIT_CODE: '2' },
      restartPolicy: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 100,
        maxDelayMs: 200,
        stableAfterMs: 60_000,
      },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => statusOf(engine, project.id) === 'FAILED', {
      timeoutMs: 20_000,
      description: 'estado FAILED após esgotar retries',
    });

    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.restartAttempt).toBe(2);
    expect(snapshot.desiredState).toBe('STOPPED');
    expect(snapshot.pid).toBeNull();

    const exhausted = engine.projects.listEvents({
      projectId: project.id,
      eventType: 'project.recovery.exhausted',
    });
    expect(exhausted).toHaveLength(1);
  });

  it('mantém CRASHED quando a política de restart está desabilitada', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, 'crash-after.mjs', {
      environment: { CRASH_AFTER_MS: '60' },
      restartPolicy: { enabled: false },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => statusOf(engine, project.id) === 'CRASHED', {
      timeoutMs: 10_000,
      description: 'estado CRASHED',
    });

    await delay(600);
    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.status).toBe('CRASHED');
    expect(snapshot.restartAttempt).toBe(0);
  });

  it('stop durante o backoff cancela o retry', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, 'crash-after.mjs', {
      environment: { CRASH_AFTER_MS: '60' },
      restartPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 1_500,
        maxDelayMs: 1_500,
        stableAfterMs: 60_000,
      },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => statusOf(engine, project.id) === 'RESTARTING', {
      timeoutMs: 10_000,
      description: 'estado RESTARTING (backoff)',
    });

    await engine.supervisor.stopProject(project.id);
    expect(statusOf(engine, project.id)).toBe('STOPPED');

    await delay(1_800);
    expect(statusOf(engine, project.id)).toBe('STOPPED');
    expect(engine.supervisor.getSnapshot(project.id).pid).toBeNull();
  });

  it('start manual durante o backoff reinicia imediatamente e zera o ciclo', async () => {
    const engine = await bootEngine();
    const markerDir = createTempDir('lsm-marker-');
    cleanups.push(async () => removeTempDir(markerDir));

    const project = addProject(engine, 'crash-once.mjs', {
      environment: { MARKER_FILE: join(markerDir, 'marker') },
      restartPolicy: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2_000,
        maxDelayMs: 2_000,
        stableAfterMs: 60_000,
      },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => statusOf(engine, project.id) === 'RESTARTING', {
      timeoutMs: 10_000,
      description: 'backoff agendado',
    });

    await engine.supervisor.startProject(project.id);
    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.status).toBe('RUNNING');
    expect(snapshot.restartAttempt).toBe(0);
    const instanceAfterManualStart = snapshot.instanceId;

    // Se o timer antigo não tivesse sido cancelado, uma nova instância surgiria.
    await delay(2_300);
    const finalSnapshot = engine.supervisor.getSnapshot(project.id);
    expect(finalSnapshot.status).toBe('RUNNING');
    expect(finalSnapshot.instanceId).toBe(instanceAfterManualStart);

    await engine.supervisor.stopProject(project.id);
  });
});
