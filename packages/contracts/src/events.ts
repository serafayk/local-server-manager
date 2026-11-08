import type { HealthStatus, LogRecord, RuntimeSnapshot, TerminationReason } from './domain';
import type { TunnelStatus } from './tunnel';

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
  /** Memória privada somada da árvore de processos (quando disponível). */
  privateBytes?: number | null;
  /** Quantidade de processos da árvore, incluindo a raiz. */
  processCount?: number;
  /** Maiores processos da árvore, para detalhamento. */
  processes?: ProjectProcessMetric[];
}

export interface ProjectProcessMetric {
  pid: number;
  name: string;
  memoryBytes: number | null;
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
  'project.recovery.aborted': { projectId: string; hint: string; attempts: number };
  'project.health.changed': {
    projectId: string;
    health: HealthStatus;
    previousHealth: HealthStatus;
    detail?: string;
  };
  'project.port.conflict': {
    projectId: string;
    port: number;
    inUse: boolean;
    ownerPid: number | null;
  };
  'project.log': LogRecord;
  'project.metrics': ProjectMetricsPayload;
  'system.metrics': SystemMetricsPayload;
  'tunnel.state.changed': { tunnelId: string; status: TunnelStatus };
  'tunnel.url': { tunnelId: string; url: string };
  'tunnel.log': LogRecord;
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
  'project.recovery.aborted',
  'project.health.changed',
  'project.port.conflict',
  'project.log',
  'project.metrics',
  'system.metrics',
  'tunnel.state.changed',
  'tunnel.url',
  'tunnel.log',
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
