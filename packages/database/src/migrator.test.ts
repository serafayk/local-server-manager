import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { openInMemoryDatabase } from './connection';
import { MIGRATIONS } from './migrations';
import { currentSchemaVersion, migrate } from './migrator';

describe('migrate', () => {
  it('aplica todas as migrações e registra a versão', () => {
    const db = openInMemoryDatabase();
    const result = migrate(db.connection);

    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect(currentSchemaVersion(db.connection)).toBe(1);
    db.close();
  });

  it('é idempotente na segunda execução', () => {
    const db = openInMemoryDatabase();
    migrate(db.connection);
    const second = migrate(db.connection);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('cria as tabelas e índices esperados', () => {
    const db = openInMemoryDatabase();
    migrate(db.connection);

    const tables = db.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as Array<{ name: string }>;
    const names = tables.map((row) => row.name);

    expect(names).toContain('projects');
    expect(names).toContain('project_groups');
    expect(names).toContain('restart_policies');
    expect(names).toContain('health_checks');
    expect(names).toContain('process_instances');
    expect(names).toContain('system_events');
    expect(names).toContain('settings');
    expect(names).toContain('schema_migrations');
    db.close();
  });

  it('detecta checksum divergente sem apagar dados', () => {
    const db = openInMemoryDatabase();
    migrate(db.connection);
    db.connection
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
      .run('checksum-adulterado');

    try {
      migrate(db.connection);
      throw new Error('esperava STORAGE_ERROR');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('STORAGE_ERROR');
    }
    db.close();
  });

  it('mantém integridade referencial ligada', () => {
    const db = openInMemoryDatabase();
    migrate(db.connection);
    expect(() =>
      db.connection
        .prepare(
          `INSERT INTO restart_policies
             (project_id, enabled, max_retries, base_delay_ms, max_delay_ms, jitter_ratio,
              stable_after_ms, reset_after_stable)
           VALUES ('inexistente', 1, 1, 1000, 1000, 0, 0, 1)`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});
