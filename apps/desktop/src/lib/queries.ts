export const queryKeys = {
  projects: ['projects'] as const,
  groups: ['groups'] as const,
  nodeVersions: ['node-versions'] as const,
  tools: ['system-tools'] as const,
  tunnels: ['tunnels'] as const,
  domains: ['domains'] as const,
  project: (id: string) => ['project', id] as const,
  logs: (id: string, instanceId: string | null, tail: number) =>
    ['logs', id, instanceId ?? 'latest', tail] as const,
  instances: (id: string) => ['instances', id] as const,
  projectEvents: (id: string) => ['project-events', id] as const,
  events: (projectId: string | null) => ['events', projectId ?? 'all'] as const,
  settings: ['settings'] as const,
  health: ['health'] as const,
  engineInfo: ['engine-info'] as const,
  tunnel: (id: string) => ['tunnel', id] as const,
  tunnelLogs: (id: string, tail: number) => ['tunnel-logs', id, tail] as const,
} as const;
