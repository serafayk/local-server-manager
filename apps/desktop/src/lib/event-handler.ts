import type { AnyDomainEvent, LogRecord, ProjectSummary } from '@lsm/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queries';

export interface EngineEventTargets {
  queryClient: QueryClient;
  appendLog: (record: LogRecord) => void;
}

/**
 * Aplica um evento do Engine ao cache do React Query e ao buffer de logs.
 * Separado do provider para poder ser testado sem WebSocket.
 */
export function applyEngineEvent(event: AnyDomainEvent, targets: EngineEventTargets): void {
  const { queryClient, appendLog } = targets;

  switch (event.type) {
    case 'project.log':
      appendLog(event.payload);
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

    default:
      return;
  }
}
