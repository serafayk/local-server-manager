import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { applyPendingRestore, BackupManager } from './backup-manager';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const directories: string[] = [];

function setup() {
  const root = createTempDir('lsm-backup-');
  directories.push(root);

  const databaseFile = join(root, 'data', 'manager.sqlite');
  mkdirSync(dirname(databaseFile), { recursive: true });
  writeFileSync(databaseFile, 'BANCO-ATUAL', 'utf8');

  const backupsDir = join(root, 'backups');
  const restoreMarkerFile = join(root, 'engine', 'restore.json');
  const manager = new BackupManager({
    databaseFile,
    backupsDir,
    restoreMarkerFile,
    logger,
  });

  return { root, databaseFile, backupsDir, restoreMarkerFile, manager };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('BackupManager', () => {
  it('cria e lista backups', () => {
    const { manager, databaseFile, backupsDir } = setup();

    const backup = manager.create();
    expect(existsSync(backup.path)).toBe(true);
    expect(backup.path.startsWith(backupsDir)).toBe(true);
    expect(readFileSync(backup.path, 'utf8')).toBe(readFileSync(databaseFile, 'utf8'));

    const list = manager.list();
    expect(list.map((item) => item.file)).toContain(backup.file);
    expect(list[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('agenda restauração e aplica no próximo boot', () => {
    const { manager, databaseFile, restoreMarkerFile, backupsDir } = setup();
    const backup = manager.create();
    writeFileSync(databaseFile, 'BANCO-NOVO', 'utf8');

    const request = manager.requestRestore(backup.file);
    expect(request.restartRequired).toBe(true);
    expect(existsSync(restoreMarkerFile)).toBe(true);

    const applied = applyPendingRestore({
      databaseFile,
      backupsDir,
      restoreMarkerFile,
      logger,
    });

    expect(applied).toBe(true);
    expect(readFileSync(databaseFile, 'utf8')).toBe('BANCO-ATUAL');
    expect(existsSync(restoreMarkerFile)).toBe(false);
    expect(manager.list().some((item) => item.file.startsWith('manager-pre-restore-'))).toBe(true);
  });

  it('rejeita backup inexistente e caminho fora da pasta', () => {
    const { manager } = setup();
    expect(() => manager.requestRestore('nao-existe.sqlite')).toThrowError();
    expect(() => manager.requestRestore('..\\..\\windows\\system32\\evil.sqlite')).toThrowError();
  });

  it('mantém o banco atual quando o marcador é inválido', () => {
    const { root, databaseFile, restoreMarkerFile, backupsDir } = setup();
    mkdirSync(dirname(restoreMarkerFile), { recursive: true });
    writeFileSync(
      restoreMarkerFile,
      JSON.stringify({ source: join(root, 'fora', 'backup.sqlite') }),
      'utf8',
    );

    const applied = applyPendingRestore({
      databaseFile,
      backupsDir,
      restoreMarkerFile,
      logger,
    });

    expect(applied).toBe(false);
    expect(readFileSync(databaseFile, 'utf8')).toBe('BANCO-ATUAL');
    expect(existsSync(restoreMarkerFile)).toBe(false);
  });
});
