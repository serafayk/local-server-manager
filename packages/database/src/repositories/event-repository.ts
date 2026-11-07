import type { DatabaseSync } from 'node:sqlite';
import type { LogLevel } from '@lsm/shared';
import { newId } from '@lsm/shared';

export interface AppendEventInput {
  projectId: string | null;
  instanceId: string | null;
  level: LogLevel;
  eventType: string;
  message: string;
  metadata?: unknown;
  createdAt?: string;
}

export interface SystemEvent {
  id: string;
  projectId: string | null;
  instanceId: string | null;
  level: LogLevel;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: string;
}

export interface ListEventsOptions {
  projectId?: string;
  eventType?: string;
  level?: LogLevel;
  limit?: number;
  offset?: number;
}

interface EventRow {
  id: string;
  project_id: string | null;
  instance_id: string | null;
  level: string;
  event_type: string;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

function mapEvent(row: EventRow): SystemEvent {
  let metadata: unknown = null;
  if (row.metadata_json !== null) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = { corrupted: true };
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    level: row.level as LogLevel,
    eventType: row.event_type,
    message: row.message,
    metadata,
    createdAt: row.created_at,
  };
}

export class SqliteEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(input: AppendEventInput): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO system_events
           (id, project_id, instance_id, level, event_type, message, metadata_json, created_at)
         VALUES ($id, $projectId, $instanceId, $level, $eventType, $message, $metadataJson, $createdAt)`,
      )
      .run({
        id,
        projectId: input.projectId,
        instanceId: input.instanceId,
        level: input.level,
        eventType: input.eventType,
        message: input.message,
        metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
    return id;
  }

  list(options: ListEventsOptions = {}): SystemEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.projectId) {
      clauses.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.eventType) {
      clauses.push('event_type = ?');
      params.push(options.eventType);
    }
    if (options.level) {
      clauses.push('level = ?');
      params.push(options.level);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    params.push(limit, offset);

    const rows = this.db
      .prepare(`SELECT * FROM system_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  /**
   * Retenção do histórico operacional (docs/07 §4). Logs de processo não
   * passam por aqui.
   */
  deleteOlderThan(cutoffIso: string): number {
    const result = this.db.prepare('DELETE FROM system_events WHERE created_at < ?').run(cutoffIso);
    return Number(result.changes);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM system_events').get() as unknown as {
      total: number;
    };
    return row.total;
  }
}
