export type TunnelKind = 'config' | 'token' | 'quick';

export type TunnelState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAILED';

export interface TunnelHostname {
  hostname: string;
  service: string;
}

/**
 * Configuração persistida de um túnel. O token nunca é exposto: apenas
 * `hasToken` indica se existe um valor armazenado.
 */
export interface TunnelConfig {
  id: string;
  name: string;
  kind: TunnelKind;
  configPath: string | null;
  targetPort: number | null;
  projectId: string | null;
  enabled: boolean;
  startOnBoot: boolean;
  metricsPort: number | null;
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TunnelStatus {
  tunnelId: string;
  state: TunnelState;
  pid: number | null;
  /** URL pública (quick tunnel) ou primeiro hostname https do config. */
  url: string | null;
  hostnames: TunnelHostname[];
  healthy: boolean | null;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface TunnelSummary {
  config: TunnelConfig;
  status: TunnelStatus;
}

export interface CreateTunnelRequest {
  name: string;
  kind: TunnelKind;
  configPath?: string | null;
  targetPort?: number | null;
  projectId?: string | null;
  token?: string | null;
  enabled?: boolean;
  startOnBoot?: boolean;
}

export interface UpdateTunnelRequest {
  name?: string;
  kind?: TunnelKind;
  configPath?: string | null;
  targetPort?: number | null;
  projectId?: string | null;
  token?: string | null;
  clearToken?: boolean;
  enabled?: boolean;
  startOnBoot?: boolean;
}
