import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@lsm/shared';

interface SettingRow {
  key: string;
  value_json: string;
  updated_at: string;
}

export class SqliteSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as unknown as
      SettingRow | undefined;
    if (!row) {
      return null;
    }
    try {
      return JSON.parse(row.value_json) as T;
    } catch (error) {
      throw new AppError('STORAGE_ERROR', `Configuração "${key}" corrompida`, undefined, {
        cause: error,
      });
    }
  }

  set(key: string, value: unknown, updatedAt = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ($key, $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), updatedAt });
  }

  delete(key: string): boolean {
    const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }

  all(): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT * FROM settings ORDER BY key')
      .all() as unknown as SettingRow[];
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value_json);
      } catch {
        result[row.key] = null;
      }
    }
    return result;
  }
}
