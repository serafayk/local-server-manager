/**
 * Estados operacionais e dimensões de saúde — docs/04-PROCESS-LIFECYCLE.md §1.
 */
export const PROJECT_STATUSES = [
  'STOPPED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'CRASHED',
  'RESTARTING',
  'FAILED',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const HEALTH_STATUSES = ['UNKNOWN', 'HEALTHY', 'UNHEALTHY'] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export type LogStream = 'stdout' | 'stderr' | 'system';

/**
 * Causa registrada de encerramento. Separa falha de spawn de crash real,
 * conforme ADR-010.
 */
export const TERMINATION_REASONS = [
  'STOP_MANUAL',
  'RESTART_MANUAL',
  'EXIT_UNEXPECTED',
  'SPAWN_FAILED',
  'STOP_TIMEOUT',
  'HEALTH_RESTART',
  'ENGINE_SHUTDOWN',
] as const;

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export const START_REASONS = ['USER', 'BOOT', 'RESTART', 'HEALTH_RESTART', 'RECOVERY'] as const;

export type StartReason = (typeof START_REASONS)[number];

export type DesiredState = 'RUNNING' | 'STOPPED';

/**
 * Transições válidas.
 *
 * Além das transições de docs/04-PROCESS-LIFECYCLE.md, a implementação usa:
 * - `CRASHED -> STARTING`: start manual após crash.
 * - `CRASHED -> FAILED`: retries esgotados já no primeiro crash (maxRetries=0).
 * - `RESTARTING -> STARTING`: o retry passa pelo spawn normal.
 * - `RESTARTING -> STOPPING`: stop manual durante o backoff.
 * Registrado em ADR-013.
 */
export const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> =
  {
    STOPPED: ['STARTING'],
    STARTING: ['RUNNING', 'CRASHED', 'STOPPING', 'FAILED'],
    RUNNING: ['STOPPING', 'CRASHED'],
    STOPPING: ['STOPPED', 'FAILED'],
    CRASHED: ['STARTING', 'RESTARTING', 'FAILED'],
    RESTARTING: ['STARTING', 'RUNNING', 'STOPPING', 'FAILED'],
    FAILED: ['STARTING'],
  };

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_STATUS_TRANSITIONS[from].includes(to);
}

export interface ProcessExitInfo {
  code: number | null;
  signal: string | null;
  reason: TerminationReason;
  at: string;
}

/**
 * Visão de estado em memória exposta pelo Supervisor e nas respostas da API.
 * Nunca contém ChildProcess.
 */
export interface RuntimeSnapshot {
  projectId: string;
  status: ProjectStatus;
  desiredState: DesiredState;
  health: HealthStatus;
  instanceId: string | null;
  pid: number | null;
  startedAt: string | null;
  restartAttempt: number;
  lastExit: ProcessExitInfo | null;
  updatedAt: string;
  /** Resultado da última checagem de porta no start (null = não verificado). */
  portInUse?: boolean | null;
}

export interface LogRecord {
  projectId: string;
  instanceId: string;
  sequence: number;
  stream: LogStream;
  timestamp: string;
  text: string;
  truncated: boolean;
}
