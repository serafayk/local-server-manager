import { existsSync } from 'node:fs';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, createTempDir, fixturePath, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('Restauração de backup entre boots', () => {
  it('substitui o banco pelo backup e preserva um backup pré-restore', async () => {
    const dataDir = createTempDir('lsm-restore-');
    directories.push(dataDir);

    const first: Engine = createEngine({ dataDir, singleInstance: false, logger });
    await first.start();
    first.projects.createProject({
      name: 'Antes do backup',
      workingDirectory: FIXTURES_DIR,
      runtime: { executable: process.execPath, args: [fixturePath('args-echo.mjs')] },
    });

    const backup = first.backups.create();
    first.projects.createProject({
      name: 'Depois do backup',
      workingDirectory: FIXTURES_DIR,
      runtime: { executable: process.execPath, args: [fixturePath('args-echo.mjs')] },
    });

    first.backups.requestRestore(backup.file);
    await first.shutdown('test');

    const second: Engine = createEngine({ dataDir, singleInstance: false, logger });
    await second.start();
    const names = second.projects.listProjects().map((project) => project.config.name);

    expect(names).toContain('Antes do backup');
    expect(names).not.toContain('Depois do backup');
    expect(second.backups.list().some((item) => item.file.startsWith('manager-pre-restore-'))).toBe(
      true,
    );
    expect(existsSync(second.paths.restoreMarkerFile)).toBe(false);

    await second.shutdown('test');
  });
});
