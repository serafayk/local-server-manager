import type { HealthStatus, ProjectStatus } from '@lsm/contracts';
import { clsx } from 'clsx';
import { Badge, type Tone } from './ui';

const STATUS_TONE: Record<ProjectStatus, Tone> = {
  STOPPED: 'zinc',
  STARTING: 'amber',
  RUNNING: 'emerald',
  STOPPING: 'amber',
  CRASHED: 'red',
  RESTARTING: 'sky',
  FAILED: 'red',
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  STOPPED: 'Parado',
  STARTING: 'Iniciando',
  RUNNING: 'Executando',
  STOPPING: 'Parando',
  CRASHED: 'Caiu',
  RESTARTING: 'Reiniciando',
  FAILED: 'Falhou',
};

const HEALTH_TONE: Record<HealthStatus, Tone> = {
  UNKNOWN: 'zinc',
  HEALTHY: 'emerald',
  UNHEALTHY: 'red',
};

const HEALTH_LABEL: Record<HealthStatus, string> = {
  UNKNOWN: 'Saúde desconhecida',
  HEALTHY: 'Saudável',
  UNHEALTHY: 'Não saudável',
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} title={`Estado: ${status}`}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function HealthBadge({ health }: { health: HealthStatus }) {
  if (health === 'UNKNOWN') {
    return null;
  }
  return (
    <Badge tone={HEALTH_TONE[health]} title={`Health check: ${health}`}>
      {HEALTH_LABEL[health]}
    </Badge>
  );
}

const DOT_CLASSES: Record<ProjectStatus, string> = {
  STOPPED: 'bg-zinc-500',
  STARTING: 'bg-amber-400 lsm-pulse',
  RUNNING: 'bg-emerald-400',
  STOPPING: 'bg-amber-400 lsm-pulse',
  CRASHED: 'bg-red-500',
  RESTARTING: 'bg-sky-400 lsm-pulse',
  FAILED: 'bg-red-500',
};

export function StatusDot({ status, className }: { status: ProjectStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('inline-block h-2 w-2 rounded-full', DOT_CLASSES[status], className)}
    />
  );
}

export function isActiveStatus(status: ProjectStatus): boolean {
  return (
    status === 'STARTING' ||
    status === 'RUNNING' ||
    status === 'STOPPING' ||
    status === 'RESTARTING'
  );
}

export { HEALTH_LABEL, STATUS_LABEL };
