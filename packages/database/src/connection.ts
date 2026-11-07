import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AppDatabase {
  readonly connection: DatabaseSync;
  readonly file: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Caminho do arquivo ou `:memory:` em testes. */
  file: string;
}

/**
 * Abre o SQLite com os pragmas definidos em docs/07-DATABASE.md §4.
 * Escritas são exclusivas do Engine (processo único), então WAL é usado
 * apenas para permitir leitura concorrente sem bloquear o supervisor.
 */
export function openDatabase(options: OpenDatabaseOptions): AppDatabase {
  const { file } = options;
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const connection = new DatabaseSync(file);
  connection.exec('PRAGMA journal_mode = WAL');
  connection.exec('PRAGMA foreign_keys = ON');
  connection.exec('PRAGMA busy_timeout = 5000');
  connection.exec('PRAGMA synchronous = NORMAL');

  return {
    connection,
    file,
    close() {
      try {
        connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Checkpoint é best-effort no fechamento.
      }
      connection.close();
    },
  };
}

export function openInMemoryDatabase(): AppDatabase {
  return openDatabase({ file: ':memory:' });
}

/**
 * Executa uma unidade de trabalho em transação. Não aninha transações: os
 * repositórios compõem apenas uma transação por operação de domínio.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserva o erro original.
    }
    throw error;
  }
}

export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromSqlBool(value: number): boolean {
  return value === 1;
}

export function parseJsonColumn<T>(value: string, column: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Coluna ${column} contém JSON inválido: ${(error as Error).message}`);
  }
}
