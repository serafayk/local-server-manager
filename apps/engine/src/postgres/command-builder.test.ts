import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { makeProjectConfig } from '../../../../tests/helpers/project';
import {
  DEFAULT_POSTGRES_PORT,
  initdbSpec,
  isInitialized,
  pgDumpSpec,
  postgresConnectionUrl,
  postgresSpawnSpec,
  resolvePostgresConfig,
} from './command-builder';

const directories: string[] = [];

function fakeInstall(version = '16'): string {
  const root = createTempDir('lsm-pg-bin-');
  directories.push(root);
  const binDir = join(root, version, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const executable of ['postgres.exe', 'initdb.exe', 'pg_dump.exe']) {
    writeFileSync(join(binDir, executable), '', 'utf8');
  }
  return binDir;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

function postgresProject(binDir: string, overrides: Record<string, unknown> = {}) {
  return makeProjectConfig({
    kind: 'postgres',
    postgres: {
      version: '16',
      binDir,
      dataDir: null,
      username: 'postgres',
      password: 'senha-forte',
      port: null,
      ...overrides,
    },
  });
}

describe('comandos do PostgreSQL dedicado', () => {
  it('resolve data dir e porta padrão do Engine', () => {
    const binDir = fakeInstall();
    const config = postgresProject(binDir);
    const resolved = resolvePostgresConfig(config, 'C:\\dados\\postgres');

    expect(resolved.dataDir).toBe(join('C:\\dados\\postgres', config.id));
    expect(resolved.port).toBe(DEFAULT_POSTGRES_PORT);
    expect(resolved.binDir).toBe(binDir);
    expect(resolved.version).toBe('16');
  });

  it('monta o spawn do servidor escutando só em loopback', () => {
    const resolved = resolvePostgresConfig(postgresProject(fakeInstall()), 'C:\\pg');
    const spec = postgresSpawnSpec(resolved);

    expect(spec.executable).toBe(join(resolved.binDir, 'postgres.exe'));
    expect(spec.args).toEqual([
      '-D',
      resolved.dataDir,
      '-p',
      String(resolved.port),
      '-c',
      'listen_addresses=127.0.0.1',
    ]);
    expect(spec.cwd).toBe(resolved.dataDir);
  });

  it('monta initdb com autenticação scram e senha via arquivo', () => {
    const resolved = resolvePostgresConfig(postgresProject(fakeInstall()), 'C:\\pg');
    const spec = initdbSpec(resolved, 'C:\\temp\\senha.txt');

    expect(spec.executable).toBe(join(resolved.binDir, 'initdb.exe'));
    expect(spec.args).toContain('--pwfile');
    expect(spec.args).toContain('--auth-host=scram-sha-256');
    expect(spec.args).toContain('--encoding=UTF8');
    expect(spec.args[spec.args.indexOf('-U') + 1]).toBe('postgres');
  });

  it('monta pg_dump com PGPASSWORD e banco padrão', () => {
    const resolved = resolvePostgresConfig(postgresProject(fakeInstall()), 'C:\\pg');
    const spec = pgDumpSpec(resolved, 'C:\\backups\\dump');

    expect(spec.args).toContain('-Fc');
    expect(spec.args).toContain('postgres');
    expect(spec.env.PGPASSWORD).toBe('senha-forte');
    expect(spec.args[spec.args.indexOf('-p') + 1]).toBe(String(resolved.port));
  });

  it('gera URL de conexão com senha codificada', () => {
    const resolved = resolvePostgresConfig(
      postgresProject(fakeInstall(), { password: 'p@ss word' }),
      'C:\\pg',
    );
    expect(postgresConnectionUrl(resolved)).toBe(
      `postgresql://postgres:p%40ss%20word@127.0.0.1:${resolved.port}/postgres`,
    );
  });

  it('detecta data dir inicializado pelo PG_VERSION', () => {
    const binDir = fakeInstall();
    const resolved = resolvePostgresConfig(postgresProject(binDir), 'C:\\pg');
    expect(isInitialized(resolved.dataDir)).toBe(false);
    mkdirSync(resolved.dataDir, { recursive: true });
    writeFileSync(join(resolved.dataDir, 'PG_VERSION'), '16', 'utf8');
    expect(isInitialized(resolved.dataDir)).toBe(true);
  });

  it('rejeita binDir sem postgres.exe com mensagem acionável', () => {
    const empty = createTempDir('lsm-pg-empty-');
    directories.push(empty);
    const config = postgresProject(empty);
    expect(() => resolvePostgresConfig(config, 'C:\\pg')).toThrowError(/postgres\.exe/);
  });
});
