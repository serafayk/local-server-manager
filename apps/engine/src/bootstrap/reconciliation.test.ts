import { spawn } from 'node:child_process';
import { isProcessAlive, getProcessStartTimeIso, killProcessTree } from '@lsm/platform-win';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  createTempDir,
  fixturePath,
  removeTempDir,
  waitFor,
} from '../../../../tests/helpers';
import { createEngine, type Engine } from './engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const engines: Engine[] = [];
const directories: string[] = [];
const orphanPids: number[] = [];

function engineFor(dataDir: string): Engine {
  const engine = createEngine({ dataDir, singleInstance: false, logger });
  engines.push(engine);
  return engine;
}

function tempDir(prefix: string): string {
  const directory = createTempDir(prefix);
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const pid of orphanPids.splice(0)) {
    await killProcessTree(pid, { force: true }).catch(() => undefined);
  }
  for (const engine of engines.splice(0)) {
    await engine.shutdown('test').catch(() => undefined);
  }
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

function addBootProject(engine: Engine, name: string) {
  return engine.projects.createProject({
    name,
    workingDirectory: FIXTURES_DIR,
    runtime: { executable: process.execPath, args: [fixturePath('http-server.mjs')] },
    startOnBoot: true,
    shutdown: { gracefulTimeoutMs: 1_000 },
  });
}

describe('reconcileInstances', () => {
  it('finaliza instância cujo processo não existe mais e libera o boot', async () => {
    const dataDir = tempDir('lsm-rec-dead-');
    const first = engineFor(dataDir);
    await first.start();
    const project = addBootProject(first, 'Reconciliação morta');

    const instanceId = '11111111-1111-4111-8111-111111111111';
    first.repositories.instances.create({
      id: instanceId,
      projectId: project.id,
      status: 'STARTING',
      createdAt: first.clock.nowIso(),
    });
    first.repositories.instances.markRunning({
      id: instanceId,
      pid: 999_999,
      pidStartedAt: '2000-01-01T00:00:00.000Z',
      startedAt: '2000-01-01T00:00:00.000Z',
    });
    await first.shutdown('test');

    const second = engineFor(dataDir);
    await second.start();

    const instance = second.repositories.instances.findById(instanceId);
    expect(instance?.endedAt).not.toBeNull();
    expect(instance?.terminationReason).toBe('EXIT_UNEXPECTED');
    expect(instance?.status).toBe('CRASHED');

    const events = second.repositories.events.list({
      projectId: project.id,
      eventType: 'engine.reconciliation.detected',
    });
    expect(events).toHaveLength(1);
    expect((events[0]?.metadata as { action: string }).action).toBe('process-gone');

    // Sem órfão vivo, o startOnBoot segue normalmente.
    await waitFor(() => second.supervisor.getSnapshot(project.id).status === 'RUNNING', {
      timeoutMs: 10_000,
      description: 'projeto de boot iniciado',
    });
    await second.shutdown('test');
  });

  it('bloqueia startOnBoot quando existe órfão comprovadamente nosso', async () => {
    const dataDir = tempDir('lsm-rec-orphan-');
    const first = engineFor(dataDir);
    await first.start();
    const project = addBootProject(first, 'Reconciliação órfã');

    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const orphanPid = orphan.pid as number;
    orphanPids.push(orphanPid);
    orphan.unref();

    await waitFor(() => isProcessAlive(orphanPid), { description: 'processo órfão vivo' });
    const startedIso = await getProcessStartTimeIso(orphanPid);
    expect(startedIso).not.toBeNull();

    const instanceId = '22222222-2222-4222-8222-222222222222';
    first.repositories.instances.create({
      id: instanceId,
      projectId: project.id,
      status: 'STARTING',
      createdAt: first.clock.nowIso(),
    });
    first.repositories.instances.markRunning({
      id: instanceId,
      pid: orphanPid,
      pidStartedAt: startedIso as string,
      startedAt: startedIso as string,
    });
    await first.shutdown('test');

    const second = engineFor(dataDir);
    await second.start();

    expect(second.supervisor.getSnapshot(project.id).status).toBe('STOPPED');

    const instance = second.repositories.instances.findById(instanceId);
    expect(instance?.status).toBe('CRASHED');

    const events = second.repositories.events.list({
      projectId: project.id,
      eventType: 'engine.reconciliation.detected',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      action: 'orphan-confirmed',
      ownershipVerified: true,
      alive: true,
    });

    // Reconciliação não mata: o órfão continua vivo até limpeza explícita.
    expect(isProcessAlive(orphanPid)).toBe(true);
    await second.shutdown('test');
  });

  it('não bloqueia boot quando o PID está vivo mas a propriedade não é comprovada', async () => {
    const dataDir = tempDir('lsm-rec-unverified-');
    const first = engineFor(dataDir);
    await first.start();
    const project = addBootProject(first, 'Reconciliação não comprovada');

    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const orphanPid = orphan.pid as number;
    orphanPids.push(orphanPid);
    orphan.unref();
    await waitFor(() => isProcessAlive(orphanPid), { description: 'processo vivo' });

    const instanceId = '33333333-3333-4333-8333-333333333333';
    first.repositories.instances.create({
      id: instanceId,
      projectId: project.id,
      status: 'STARTING',
      createdAt: first.clock.nowIso(),
    });
    first.repositories.instances.markRunning({
      id: instanceId,
      pid: orphanPid,
      // StartTime de outro instante: simula reuso de PID.
      pidStartedAt: '2000-01-01T00:00:00.000Z',
      startedAt: '2000-01-01T00:00:00.000Z',
    });
    await first.shutdown('test');

    const second = engineFor(dataDir);
    await second.start();

    const events = second.repositories.events.list({
      projectId: project.id,
      eventType: 'engine.reconciliation.detected',
    });
    expect((events[0]?.metadata as { action: string }).action).toBe('pid-alive-unverified');

    await waitFor(() => second.supervisor.getSnapshot(project.id).status === 'RUNNING', {
      timeoutMs: 10_000,
      description: 'boot liberado apesar do PID não comprovado',
    });
    await second.shutdown('test');
  });
});
