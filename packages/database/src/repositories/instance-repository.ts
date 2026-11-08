import type { DatabaseSync } from 'node:sqlite';
import type { ProjectStatus, TerminationReason } from '@lsm/contracts';

export interface CreateInstanceInput {
  id: string;
  projectId: string;
  status: ProjectStatus;
  createdAt: string;
}

export interface MarkRunningInput {
  id: string;
  /** `null` quando o serviço é estático (sem processo próprio). */
  pid: number | null;
  /** Instante de criação esperado do processo - usado contra reuso de PID. */
  pidStartedAt: string | null;
  startedAt: string;
}

export interface FinishInstanceInput {
  id: string;
  endedAt: string;
  exitCode: number | null;
  exitSignal: string | null;
  terminationReason: TerminationReason;
  status: ProjectStatus;
}

export interface ProcessInstance {
  id: string;
  projectId: string;
  pid: number | null;
  pidStartedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  terminationReason: TerminationReason | null;
  status: ProjectStatus;
  createdAt: string;
}

interface InstanceRow {
  id: string;
  project_id: string;
  pid: number | null;
  pid_started_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  termination_reason: string | null;
  status: string;
  created_at: string;
}

function mapInstance(row: InstanceRow): ProcessInstance {
  return {
    id: row.id,
    projectId: row.project_id,
    pid: row.pid,
    pidStartedAt: row.pid_started_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    terminationReason: row.termination_reason as TerminationReason | null,
    status: row.status as ProjectStatus,
    createdAt: row.created_at,
  };
}

export class SqliteInstanceRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateInstanceInput): void {
    this.db
      .prepare(
        `INSERT INTO process_instances (id, project_id, status, created_at)
         VALUES ($id, $projectId, $status, $createdAt)`,
      )
      .run({
        id: input.id,
        projectId: input.projectId,
        status: input.status,
        createdAt: input.createdAt,
      });
  }

  markRunning(input: MarkRunningInput): void {
    this.db
      .prepare(
        `UPDATE process_instances SET
           pid = $pid, pid_started_at = $pidStartedAt, started_at = $startedAt, status = 'RUNNING'
         WHERE id = $id`,
      )
      .run({
        id: input.id,
        pid: input.pid,
        pidStartedAt: input.pidStartedAt,
        startedAt: input.startedAt,
      });
  }

  finish(input: FinishInstanceInput): void {
    this.db
      .prepare(
        `UPDATE process_instances SET
           ended_at = $endedAt, exit_code = $exitCode, exit_signal = $exitSignal,
           termination_reason = $terminationReason, status = $status
         WHERE id = $id`,
      )
      .run({
        id: input.id,
        endedAt: input.endedAt,
        exitCode: input.exitCode,
        exitSignal: input.exitSignal,
        terminationReason: input.terminationReason,
        status: input.status,
      });
  }

  findById(id: string): ProcessInstance | null {
    const row = this.db
      .prepare('SELECT * FROM process_instances WHERE id = ?')
      .get(id) as unknown as InstanceRow | undefined;
    return row ? mapInstance(row) : null;
  }

  listByProject(projectId: string, limit = 50): ProcessInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM process_instances
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as unknown as InstanceRow[];
    return rows.map(mapInstance);
  }

  /**
   * Instâncias que ficaram sem encerramento registrado. Consultado no boot
   * para reconciliação (Fase 2) — nunca implica matar o processo.
   */
  listUnfinished(): ProcessInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM process_instances
         WHERE ended_at IS NULL AND status IN ('STARTING', 'RUNNING', 'STOPPING', 'RESTARTING')
         ORDER BY created_at ASC`,
      )
      .all() as unknown as InstanceRow[];
    return rows.map(mapInstance);
  }
}
