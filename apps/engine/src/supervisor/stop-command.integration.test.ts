import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

async function bootEngine(): Promise<Engine> {
  const dataDir = createTempDir('lsm-stopcmd-');
  const engine = createEngine({ dataDir, singleInstance: false, logger });
  await engine.start();
  cleanups.unshift(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return engine;
}

function appDirectory(): string {
  const directory = createTempDir('lsm-stopcmd-app-');
  writeFileSync(join(directory, 'app.mjs'), 'setInterval(() => {}, 1000);\n', 'utf8');
  cleanups.push(async () => removeTempDir(directory));
  return directory;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.shift();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe('comando de parada', () => {
  it('executa o comando antes de encerrar o processo', async () => {
    const engine = await bootEngine();
    const directory = appDirectory();
    const marker = join(directory, 'stopped.txt');
    writeFileSync(
      join(directory, 'stop.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'parado');\n`,
      'utf8',
    );

    const project = engine.projects.createProject({
      name: 'com-stop',
      workingDirectory: directory,
      runtime: { executable: process.execPath, args: ['app.mjs'] },
      stopCommand: { executable: process.execPath, args: ['stop.mjs'] },
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    await engine.supervisor.startProject(project.id);
    expect(engine.supervisor.getSnapshot(project.id).status).toBe('RUNNING');

    await engine.supervisor.stopProject(project.id);
    expect(engine.supervisor.getSnapshot(project.id).status).toBe('STOPPED');
    expect(readFileSync(marker, 'utf8')).toBe('parado');
  }, 30_000);

  it('não impede a parada quando o comando falha', async () => {
    const engine = await bootEngine();
    const directory = appDirectory();

    const project = engine.projects.createProject({
      name: 'stop-falha',
      workingDirectory: directory,
      runtime: { executable: process.execPath, args: ['app.mjs'] },
      stopCommand: { executable: process.execPath, args: ['-e', 'process.exit(3)'] },
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    await engine.supervisor.startProject(project.id);
    await engine.supervisor.stopProject(project.id);
    expect(engine.supervisor.getSnapshot(project.id).status).toBe('STOPPED');
  }, 30_000);
});
