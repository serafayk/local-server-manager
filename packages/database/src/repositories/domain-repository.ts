import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AppError } from '@lsm/shared';

export interface DomainRecord {
  id: string;
  host: string;
  projectId: string;
  port: number | null;
  createdAt: string;
  updatedAt: string;
}

interface DomainRow {
  id: string;
  host: string;
  project_id: string;
  port: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_DOMAIN = `
SELECT id, host, project_id, port, created_at, updated_at
FROM domains
`;

function mapRow(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    host: row.host,
    projectId: row.project_id,
    port: row.port,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueHostViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: domains\.host/i.test(error.message);
}

export class SqliteDomainRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(record: DomainRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO domains (id, host, project_id, port, created_at, updated_at)
           VALUES ($id, $host, $projectId, $port, $createdAt, $updatedAt)`,
        )
        .run(this.params(record));
    } catch (error) {
      if (isUniqueHostViolation(error)) {
        throw new AppError(
          'DOMAIN_HOST_IN_USE',
          `Já existe um domínio configurado para "${record.host}"`,
        );
      }
      throw error;
    }
  }

  update(record: DomainRecord): void {
    try {
      const result = this.db
        .prepare(
          `UPDATE domains SET host = $host, project_id = $projectId, port = $port,
             updated_at = $updatedAt
           WHERE id = $id`,
        )
        .run(this.params(record));
      if (result.changes === 0) {
        throw new AppError('DOMAIN_NOT_FOUND', `Domínio não encontrado: ${record.id}`);
      }
    } catch (error) {
      if (isUniqueHostViolation(error)) {
        throw new AppError(
          'DOMAIN_HOST_IN_USE',
          `Já existe um domínio configurado para "${record.host}"`,
        );
      }
      throw error;
    }
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    return result.changes > 0;
  }

  findById(id: string): DomainRecord | null {
    const row = this.db.prepare(`${SELECT_DOMAIN} WHERE id = ?`).get(id) as unknown as
      DomainRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByHost(host: string): DomainRecord | null {
    const row = this.db
      .prepare(`${SELECT_DOMAIN} WHERE host = ? COLLATE NOCASE`)
      .get(host) as unknown as DomainRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(): DomainRecord[] {
    const rows = this.db
      .prepare(`${SELECT_DOMAIN} ORDER BY host COLLATE NOCASE ASC`)
      .all() as unknown as DomainRow[];
    return rows.map(mapRow);
  }

  listByProject(projectId: string): DomainRecord[] {
    const rows = this.db
      .prepare(`${SELECT_DOMAIN} WHERE project_id = ? ORDER BY host COLLATE NOCASE ASC`)
      .all(projectId) as unknown as DomainRow[];
    return rows.map(mapRow);
  }

  private params(record: DomainRecord): Record<string, SQLInputValue> {
    return {
      id: record.id,
      host: record.host,
      projectId: record.projectId,
      port: record.port,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
