import type { HealthStatus, LogRecord, RuntimeSnapshot, TerminationReason } from './domain';

/**
 * Payloads dos eventos de domínio — docs/06-API-CONTRACTS.md §4.
 * O transporte (WebSocket, Fase 3) reutiliza exatamente estes tipos.
 */
export interface ProjectMetricsPayload {
  projectId: string;
  pid: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  uptimeMs: number;
}

export interface SystemMetricsPayload {
  managedProcesses: number;
  running: number;
  crashed: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

export interface DomainEventPayloads {
  'engine.ready': { pid: number; dataDir: string; startedAt: string };
  'engine.shutdown': { reason: string };
  'engine.notice': { level: 'info' | 'warn' | 'error'; message: string; code?: string };
  'project.created': { projectId: string; name: string };
  'project.updated': { projectId: string; name: string };
  'project.deleted': { projectId: string; name: string };
  'project.state.changed': { snapshot: RuntimeSnapshot; previousStatus: string };
  'project.process.started': {
    projectId: string;
    instanceId: string;
    pid: number;
    startedAt: string;
  };
  'project.process.exited': {
    projectId: string;
    instanceId: string;
    pid: number | null;
    exitCode: number | null;
    signal: string | null;
    reason: TerminationReason;
  };
  'project.crashed': {
    projectId: string;
    instanceId: string;
    reason: TerminationReason;
    exitCode: number | null;
  };
  'project.restart.scheduled': { projectId: string; attempt: number; delayMs: number };
  'project.restart.started': { projectId: string; attempt: number };
  'project.recovery.exhausted': { projectId: string; attempts: number };
  'project.health.changed': {
    projectId: string;
    health: HealthStatus;
    previousHealth: HealthStatus;
  };
  'project.log': LogRecord;
  'project.metrics': ProjectMetricsPayload;
  'system.metrics': SystemMetricsPayload;
}

export type DomainEventType = keyof DomainEventPayloads;

/** Lista em runtime para assinatura/broadcast (WebSocket). */
export const DOMAIN_EVENT_TYPES = [
  'engine.ready',
  'engine.shutdown',
  'engine.notice',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.state.changed',
  'project.process.started',
  'project.process.exited',
  'project.crashed',
  'project.restart.scheduled',
  'project.restart.started',
  'project.recovery.exhausted',
  'project.health.changed',
  'project.log',
  'project.metrics',
  'system.metrics',
] as const satisfies readonly DomainEventType[];

export interface DomainEvent<K extends DomainEventType = DomainEventType> {
  eventId: string;
  protocolVersion: number;
  type: K;
  timestamp: string;
  projectId?: string;
  payload: DomainEventPayloads[K];
}

/**
 * União discriminada por `type`, para consumidores que fazem switch e
 * precisam do payload correlacionado.
 */
export type AnyDomainEvent = {
  [K in DomainEventType]: DomainEvent<K>;
}[DomainEventType];
