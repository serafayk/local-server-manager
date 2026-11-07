import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@lsm/shared';
import { MIGRATIONS, type Migration } from './migrations';

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrateOptions {
  /** Diretório para backup antes de aplicar migrações pendentes. */
  backupDir?: string;
  /** Arquivo do banco, necessário para backup consistente. */
  databaseFile?: string;
  now?: () => string;
}

export interface MigrateResult {
  applied: number[];
  backupFile: string | null;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`);
}

function readApplied(db: DatabaseSync): Map<number, AppliedMigrationRow> {
  const rows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as unknown as AppliedMigrationRow[];
  return new Map(rows.map((row) => [row.version, row]));
}

function hasPending(applied: Map<number, AppliedMigrationRow>): boolean {
  return MIGRATIONS.some((migration) => !applied.has(migration.version));
}

/**
 * Aplica migrações pendentes em transação individual, com checksum.
 * Nunca apaga o banco: checksum divergente é erro explícito.
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrateResult {
  const now = options.now ?? (() => new Date().toISOString());
  ensureMigrationsTable(db);
  const applied = readApplied(db);
  let backupFile: string | null = null;

  if (applied.size > 0 && hasPending(applied) && options.databaseFile && options.backupDir) {
    mkdirSync(options.backupDir, { recursive: true });
    const stamp = now().replace(/[:.]/g, '-');
    backupFile = join(options.backupDir, `manager-${stamp}.sqlite`);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      if (existsSync(options.databaseFile)) {
        copyFileSync(options.databaseFile, backupFile);
      } else {
        backupFile = null;
      }
    } catch (error) {
      throw new AppError('STORAGE_ERROR', 'Falha ao criar backup antes da migração', undefined, {
        cause: error,
      });
    }
  }

  const appliedNow: number[] = [];
  for (const migration of MIGRATIONS) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== checksum(migration.sql)) {
        throw new AppError(
          'STORAGE_ERROR',
          `Migração ${migration.version} (${migration.name}) diverge do checksum registrado. ` +
            'O banco pode ter sido alterado manualmente.',
        );
      }
      continue;
    }
    applyMigration(db, migration, now());
    appliedNow.push(migration.version);
  }

  return { applied: appliedNow, backupFile };
}

function applyMigration(db: DatabaseSync, migration: Migration, appliedAt: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(migration.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(migration.version, migration.name, checksum(migration.sql), appliedAt);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback pode falhar se a transação já foi encerrada; o erro original importa mais.
    }
    throw new AppError(
      'STORAGE_ERROR',
      `Falha ao aplicar migração ${migration.version} (${migration.name})`,
      undefined,
      { cause: error },
    );
  }
}

export function currentSchemaVersion(db: DatabaseSync): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
}
