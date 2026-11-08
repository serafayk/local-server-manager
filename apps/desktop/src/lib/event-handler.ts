import type {
  AnyDomainEvent,
  LogRecord,
  ProjectMetricsPayload,
  ProjectSummary,
  SystemMetricsPayload,
  TunnelStatus,
  TunnelSummary,
} from '@lsm/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queries';

export interface EngineEventTargets {
  queryClient: QueryClient;
  appendLog: (record: LogRecord) => void;
  setProjectMetrics?: (metrics: ProjectMetricsPayload) => void;
  setSystemMetrics?: (metrics: SystemMetricsPayload) => void;
  setHealthNote?: (projectId: string, note: string) => void;
}

/**
 * Aplica um evento do Engine ao cache do React Query e ao buffer de logs.
 * Separado do provider para poder ser testado sem WebSocket.
 */
export function applyEngineEvent(event: AnyDomainEvent, targets: EngineEventTargets): void {
  const { queryClient, appendLog, setProjectMetrics, setSystemMetrics, setHealthNote } = targets;

  switch (event.type) {
    case 'project.log':
      appendLog(event.payload);
      return;

    case 'project.metrics':
      setProjectMetrics?.(event.payload);
      return;

    case 'system.metrics':
      setSystemMetrics?.(event.payload);
      return;

    case 'project.health.changed':
      setHealthNote?.(event.payload.projectId, event.payload.detail ?? event.payload.health);
      return;

    case 'project.state.changed': {
      const snapshot = event.payload.snapshot;
      queryClient.setQueryData<ProjectSummary[]>(queryKeys.projects, (current) =>
        current?.map((summary) =>
          summary.config.id === snapshot.projectId ? { ...summary, runtime: snapshot } : summary,
        ),
      );
      queryClient.setQueryData<ProjectSummary>(queryKeys.project(snapshot.projectId), (current) =>
        current ? { ...current, runtime: snapshot } : current,
      );
      return;
    }

    case 'project.created':
    case 'project.updated':
    case 'project.deleted': {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(event.payload.projectId) });
      return;
    }

    case 'tunnel.state.changed': {
      const status = event.payload.status;
      queryClient.setQueryData<TunnelSummary[]>(queryKeys.tunnels, (current) =>
        current?.map((summary) =>
          summary.config.id === status.tunnelId ? { ...summary, status } : summary,
        ),
      );
      queryClient.setQueryData<TunnelStatus>(queryKeys.tunnel(status.tunnelId), status);
      return;
    }

    case 'tunnel.url': {
      queryClient.setQueryData<TunnelSummary[]>(queryKeys.tunnels, (current) =>
        current?.map((summary) =>
          summary.config.id === event.payload.tunnelId
            ? { ...summary, status: { ...summary.status, url: event.payload.url } }
            : summary,
        ),
      );
      return;
    }

    default:
      return;
  }
}
