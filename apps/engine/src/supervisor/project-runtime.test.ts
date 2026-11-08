import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '@lsm/contracts';
import { isProcessAlive } from '@lsm/platform-win';
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
let projectCounter = 0;

async function bootEngine(): Promise<Engine> {
  const dataDir = createTempDir('lsm-rt-');
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

function addProject(engine: Engine, overrides: Record<string, unknown> = {}): ProjectConfig {
  projectCounter += 1;
  return engine.projects.createProject({
    name: `proj-${projectCounter}-${Date.now()}`,
    workingDirectory: FIXTURES_DIR,
    runtime: { executable: process.execPath, args: [fixturePath('http-server.mjs')] },
    shutdown: { gracefulTimeoutMs: 2_000 },
    ...overrides,
  });
}

function statusOf(engine: Engine, projectId: string): string {
  return engine.supervisor.getSnapshot(projectId).status;
}

function logsOf(engine: Engine, projectId: string) {
  return engine.projects.tailLogs(projectId, 100).records;
}

describe('ProjectRuntime — ciclo de vida com processos reais', () => {
  it('inicia, expõe PID vivo, captura log e para', async () => {
    const engine = await bootEngine();
    const project = addProject(engine);

    await engine.supervisor.startProject(project.id);
    const running = engine.supervisor.getSnapshot(project.id);

    expect(running.status).toBe('RUNNING');
    expect(running.pid).toBeGreaterThan(0);
    expect(isProcessAlive(running.pid as number)).toBe(true);

    await waitFor(
      () => logsOf(engine, project.id).some((record) => record.text.includes('listening on')),
      { description: 'log de listening do fixture' },
    );

    await engine.supervisor.stopProject(project.id);
    const stopped = engine.supervisor.getSnapshot(project.id);

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.pid).toBeNull();
    expect(stopped.lastExit?.reason).toBe('STOP_MANUAL');
    expect(isProcessAlive(running.pid as number)).toBe(false);
  });

  it('mantém logs disponíveis depois que o processo termina', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      runtime: { executable: process.execPath, args: [fixturePath('log-flood.mjs')] },
      environment: { LINES: '5' },
    });

    await engine.supervisor.startProject(project.id);
    const instanceId = engine.supervisor.getSnapshot(project.id).instanceId as string;
    await waitFor(() => logsOf(engine, project.id).some((record) => record.text === 'out 5'), {
      description: 'linha out 5',
    });

    await engine.supervisor.stopProject(project.id);

    const records = logsOf(engine, project.id);
    expect(records.some((record) => record.text === 'out 5')).toBe(true);
    expect(records.some((record) => record.stream === 'stderr')).toBe(true);
    expect(existsSync(engine.logManager.logFileFor(project.id, instanceId))).toBe(true);
  });

  it('detecta crash inesperado e preserva exit code', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      runtime: { executable: process.execPath, args: [fixturePath('crash-after.mjs')] },
      environment: { CRASH_AFTER_MS: '80', EXIT_CODE: '3' },
      // Sem recovery para observar o estado CRASHED terminal.
      restartPolicy: { enabled: false },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => statusOf(engine, project.id) === 'CRASHED', {
      timeoutMs: 10_000,
      description: 'estado CRASHED',
    });

    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.lastExit?.reason).toBe('EXIT_UNEXPECTED');
    expect(snapshot.lastExit?.code).toBe(3);
    expect(snapshot.desiredState).toBe('RUNNING');
  });

  it('stop manual não dispara reinício', async () => {
    const engine = await bootEngine();
    const project = addProject(engine);

    await engine.supervisor.startProject(project.id);
    await engine.supervisor.stopProject(project.id);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.status).toBe('STOPPED');
    expect(snapshot.pid).toBeNull();
    expect(snapshot.desiredState).toBe('STOPPED');
  });

  it('rejeita start duplicado', async () => {
    const engine = await bootEngine();
    const project = addProject(engine);
    await engine.supervisor.startProject(project.id);

    await expect(engine.supervisor.startProject(project.id)).rejects.toMatchObject({
      code: 'PROJECT_ALREADY_RUNNING',
    });
  });

  it('falha com EXECUTABLE_NOT_FOUND sem sujar o estado', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      runtime: { executable: 'C:\\nao-existe-lsm\\nope.exe', args: [] },
    });

    await expect(engine.supervisor.startProject(project.id)).rejects.toMatchObject({
      code: 'EXECUTABLE_NOT_FOUND',
    });
    expect(statusOf(engine, project.id)).toBe('STOPPED');
  });

  it('falha com WORKING_DIRECTORY_NOT_FOUND', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      workingDirectory: 'C:\\nao-existe-lsm-diretorio',
    });

    await expect(engine.supervisor.startProject(project.id)).rejects.toMatchObject({
      code: 'WORKING_DIRECTORY_NOT_FOUND',
    });
  });

  it('restart cria nova instância', async () => {
    const engine = await bootEngine();
    const project = addProject(engine);

    await engine.supervisor.startProject(project.id);
    const firstInstance = engine.supervisor.getSnapshot(project.id).instanceId;

    await engine.supervisor.restartProject(project.id);
    const snapshot = engine.supervisor.getSnapshot(project.id);

    expect(snapshot.status).toBe('RUNNING');
    expect(snapshot.instanceId).not.toBe(firstInstance);
    expect(snapshot.lastExit?.reason).toBe('RESTART_MANUAL');
  });

  it('serializa stop solicitado durante STARTING', async () => {
    const engine = await bootEngine();
    const project = addProject(engine);

    const startPromise = engine.supervisor.startProject(project.id);
    const stopPromise = engine.supervisor.stopProject(project.id);
    await Promise.allSettled([startPromise, stopPromise]);

    expect(statusOf(engine, project.id)).toBe('STOPPED');
  });

  it('encerra a árvore de processos sem tocar em processos externos', async () => {
    const engine = await bootEngine();
    const pidDirectory = createTempDir('lsm-pids-');
    const pidFile = join(pidDirectory, 'pids.json');
    try {
      const project = addProject(engine, {
        runtime: { executable: process.execPath, args: [fixturePath('tree-parent.mjs')] },
        environment: { PID_FILE: pidFile },
        shutdown: { gracefulTimeoutMs: 1_000 },
      });

      await engine.supervisor.startProject(project.id);
      await waitFor(() => existsSync(pidFile), { description: 'arquivo de PIDs' });

      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        parent: number;
        child: number;
      };
      expect(pids.parent).toBe(engine.supervisor.getSnapshot(project.id).pid);
      expect(isProcessAlive(pids.child)).toBe(true);

      await engine.supervisor.stopProject(project.id);

      await waitFor(() => !isProcessAlive(pids.child), {
        timeoutMs: 10_000,
        description: 'processo filho encerrado',
      });
      expect(isProcessAlive(pids.parent)).toBe(false);
    } finally {
      removeTempDir(pidDirectory);
    }
  });

  it('trunca linha acima do limite de 8 KB', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      runtime: { executable: process.execPath, args: [fixturePath('long-line.mjs')] },
      environment: { LINE_SIZE: '20000' },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(
      () => logsOf(engine, project.id).some((record) => record.text === 'after-long-line'),
      { description: 'linha após a linha longa' },
    );

    const truncated = logsOf(engine, project.id).find((record) => record.truncated);
    expect(truncated?.text).toHaveLength(8_192);
    expect(logsOf(engine, project.id).some((record) => record.text === 'after-long-line')).toBe(
      true,
    );
  });

  it('preserva argumentos com espaços, ambiente e cwd', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      runtime: {
        executable: process.execPath,
        args: [fixturePath('args-echo.mjs'), '--flag com espaço', 'simples'],
      },
      environment: { FOO: 'bar' },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(
      () => logsOf(engine, project.id).some((record) => record.text.includes('"foo":"bar"')),
      { description: 'linha com ambiente' },
    );

    const line = logsOf(engine, project.id).find((record) => record.text.includes('"foo":"bar"'));
    const payload = JSON.parse(line?.text ?? '{}') as {
      args: string[];
      cwd: string;
      foo: string;
    };
    expect(payload.args).toEqual(['--flag com espaço', 'simples']);
    expect(payload.cwd.toLowerCase()).toBe(FIXTURES_DIR.toLowerCase());
    expect(payload.foo).toBe('bar');
  });

  it('executa operações em lote com resultado por projeto', async () => {
    const engine = await bootEngine();
    const first = addProject(engine);
    const second = addProject(engine);

    const started = await engine.supervisor.startProjects([first.id, second.id]);
    expect(started).toEqual([
      { projectId: first.id, success: true },
      { projectId: second.id, success: true },
    ]);

    const stopped = await engine.supervisor.stopProjects([first.id, second.id]);
    expect(stopped.every((result) => result.success)).toBe(true);
  });

  it('não remove projeto em execução', async () => {
    const engine = await bootEngine();
    const project = addProject(engine);
    await engine.supervisor.startProject(project.id);

    try {
      engine.projects.deleteProject(project.id);
      throw new Error('esperava PROJECT_ALREADY_RUNNING');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PROJECT_ALREADY_RUNNING');
    }

    await engine.supervisor.stopProject(project.id);
    expect(() => engine.projects.deleteProject(project.id)).not.toThrow();
  });

  it('aborta o retry e explica a causa quando a falha não é recuperável', async () => {
    const engine = await bootEngine();
    const project = addProject(engine, {
      runtime: { executable: process.execPath, args: [fixturePath('fail-with-hint.mjs')] },
      restartPolicy: {
        enabled: true,
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 200,
        jitterRatio: 0,
        stableAfterMs: 60_000,
        resetRetriesAfterStable: true,
      },
    });

    await engine.supervisor.startProject(project.id);
    await waitFor(() => statusOf(engine, project.id) === 'FAILED', {
      timeoutMs: 8_000,
      description: 'FAILED após falha fatal',
    });

    const snapshot = engine.supervisor.getSnapshot(project.id);
    expect(snapshot.lastFailureHint).toContain('Porta');
    expect(snapshot.restartAttempt).toBe(0);
    expect(
      engine.projects
        .listEvents({ projectId: project.id, limit: 50 })
        .map((event) => event.eventType),
    ).toContain('project.recovery.aborted');
  });
});
