import type { EngineSettings, ProjectSummary, RuntimeSnapshot } from '@lsm/contracts';
import { useQuery } from '@tanstack/react-query';
import type { SystemEventDto } from './api';
import { queryKeys } from './queries';
import { useEngine } from '../providers/engine-provider';

export function useProjectsQuery() {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => client.listProjects(),
    refetchInterval: 5_000,
  });
}

export function useGroupsQuery() {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => client.listGroups(),
  });
}

export function useNodeVersionsQuery() {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.nodeVersions,
    queryFn: () => client.getNodeVersions(),
    staleTime: 60_000,
  });
}

export function useTunnelsQuery() {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.tunnels,
    queryFn: () => client.listTunnels(),
    refetchInterval: 5_000,
  });
}

export function useProjectQuery(id: string | undefined) {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.project(id ?? ''),
    queryFn: () => client.getProject(id as string),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });
}

export function useProjectInstances(id: string | undefined) {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.instances(id ?? ''),
    queryFn: () => client.getInstances(id as string, 30),
    enabled: Boolean(id),
  });
}

export function useProjectLogs(id: string | undefined, instanceId: string | null, tail = 500) {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.logs(id ?? '', instanceId, tail),
    queryFn: () => client.getLogs(id as string, tail, instanceId ?? undefined),
    enabled: Boolean(id),
  });
}

export function useProjectEvents(id: string | undefined, limit = 50) {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.projectEvents(id ?? ''),
    queryFn: () => client.getProjectEvents(id as string, limit),
    enabled: Boolean(id),
    refetchInterval: 3_000,
  });
}

export function useGlobalEvents(projectId: string | null, limit = 100) {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.events(projectId),
    queryFn: () => client.getEvents(projectId === null ? { limit } : { limit, projectId }),
    refetchInterval: 3_000,
  });
}

export function useEngineSettings() {
  const { client } = useEngine();
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => client.getSettings(),
  });
}

export type { EngineSettings, ProjectSummary, RuntimeSnapshot, SystemEventDto };
