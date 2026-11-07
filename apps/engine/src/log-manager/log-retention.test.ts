import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { runLogRetention } from './log-retention';

const DAY_MS = 24 * 60 * 60 * 1_000;
const directories: string[] = [];

function setup(): string {
  const logsDir = createTempDir('lsm-retention-');
  directories.push(logsDir);
  return logsDir;
}

function writeFile(path: string, content: string, ageDays: number): void {
  writeFileSync(path, content, 'utf8');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  utimesSync(path, when, when);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('runLogRetention', () => {
  it('remove logs expirados preservando ativos e recentes', () => {
    const logsDir = setup();
    const projectDir = join(logsDir, 'project-1');
    mkdirSync(projectDir, { recursive: true });

    writeFile(join(projectDir, 'active.log'), 'x\n', 30);
    writeFile(join(projectDir, 'expired-a.log'), 'y\n', 30);
    writeFile(join(projectDir, 'expired-b.log.1'), 'z\n', 40);
    writeFile(join(projectDir, 'fresh.log'), 'w\n', 0);
    writeFile(join(projectDir, 'not-a-log.txt'), 'keep\n', 365);

    const result = runLogRetention({
      logsDir,
      retentionByProject: new Map([['project-1', 7]]),
      activeInstanceIds: new Set(['active']),
      nowMs: Date.now(),
    });

    expect(result.removedFiles).toBe(2);
    expect(result.skippedActive).toBe(1);
    expect(result.removedBytes).toBeGreaterThan(0);

    expect(existsSync(join(projectDir, 'active.log'))).toBe(true);
    expect(existsSync(join(projectDir, 'fresh.log'))).toBe(true);
    expect(existsSync(join(projectDir, 'not-a-log.txt'))).toBe(true);
    expect(existsSync(join(projectDir, 'expired-a.log'))).toBe(false);
    expect(existsSync(join(projectDir, 'expired-b.log.1'))).toBe(false);
  });

  it('usa retenção default para diretório de projeto desconhecido e remove pasta vazia', () => {
    const logsDir = setup();
    const orphanDir = join(logsDir, 'projeto-removido');
    mkdirSync(orphanDir, { recursive: true });
    writeFile(join(orphanDir, 'velho.log'), 'a\n', 30);

    const result = runLogRetention({
      logsDir,
      retentionByProject: new Map(),
      activeInstanceIds: new Set(),
      nowMs: Date.now(),
    });

    expect(result.removedFiles).toBe(1);
    expect(result.removedDirectories).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it('não remove nada dentro da retenção', () => {
    const logsDir = setup();
    const projectDir = join(logsDir, 'p');
    mkdirSync(projectDir, { recursive: true });
    writeFile(join(projectDir, 'recente.log'), 'a\n', 2);

    const result = runLogRetention({
      logsDir,
      retentionByProject: new Map([['p', 7]]),
      activeInstanceIds: new Set(),
      nowMs: Date.now(),
    });

    expect(result.removedFiles).toBe(0);
    expect(existsSync(join(projectDir, 'recente.log'))).toBe(true);
  });

  it('tolera diretório de logs inexistente', () => {
    const logsDir = join(createTempDir('lsm-missing-'), 'nao-existe');
    const result = runLogRetention({
      logsDir,
      retentionByProject: new Map(),
      activeInstanceIds: new Set(),
    });
    expect(result.removedFiles).toBe(0);
  });
});
