import type {
  BulkProjectResult,
  BuildResult,
  CreateGroupRequest,
  DetectProjectResponse,
  DomainEvent,
  DomainRoute,
  DomainsOverview,
  DomainsStatus,
  EngineInfo,
  EngineSettings,
  ErrorCode,
  ExportBundle,
  HostsSyncResult,
  ImportConfigResponse,
  LaunchPreview,
  LogRecord,
  NodeInstallation,
  OperationResult,
  ProjectConfig,
  ProjectGroup,
  ProjectInstance,
  ProjectSummary,
  PostgresBackupResult,
  PostgresConnectionInfo,
  RuntimeSnapshot,
  ScanRootResponse,
  SystemTools,
  TunnelStatus,
  TunnelSummary,
  UpdateGroupRequest,
  UpdateTunnelRequest,
  CreateTunnelRequest,
  WebAuthStatus,
} from '@lsm/contracts';

export interface EngineEndpoint {
  baseUrl: string;
  token: string;
  websocketPath: string;
}

export interface SystemEventDto {
  id: string;
  projectId: string | null;
  instanceId: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: string;
}

export interface HealthDto {
  status: string;
  pid: number;
  startedAt: string;
  uptimeMs: number;
  projects: number;
}

export interface LogsResponse {
  instanceId: string | null;
  records: LogRecord[];
}

export interface BulkResponse {
  results: BulkProjectResult[];
  levels?: string[][];
  skipped?: Array<{ projectId: string; reason: string }>;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

export interface BackupInfo {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface RestoreRequestResult {
  file: string;
  restartRequired: true;
}

export interface DetectRequest {
  directory: string;
}

export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export interface CreateProjectBody {
  name: string;
  description?: string | null;
  workingDirectory: string;
  runtime: { executable: string; args: string[] };
  environment?: Record<string, string>;
  port?: number | null;
  portSource?: 'none' | 'fixed';
  enabled?: boolean;
  startOnBoot?: boolean;
  startupOrder?: number;
  restartPolicy?: Record<string, unknown>;
  healthCheck?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  shutdown?: Record<string, unknown>;
}

export type UpdateProjectBody = Partial<CreateProjectBody>;

export type ImportProjectBody = Omit<CreateProjectBody, 'runtime'> & {
  script?: string;
};

export class EngineClient {
  constructor(readonly endpoint: EngineEndpoint) {}

  listProjects(): Promise<ProjectSummary[]> {
    return this.request('GET', '/projects');
  }

  getProject(id: string): Promise<ProjectSummary> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}`);
  }

  createProject(body: CreateProjectBody | Record<string, unknown>): Promise<ProjectConfig> {
    return this.request('POST', '/projects', body);
  }

  importProject(body: ImportProjectBody | Record<string, unknown>): Promise<ProjectConfig> {
    return this.request('POST', '/projects/import', body);
  }

  updateProject(id: string, body: UpdateProjectBody): Promise<ProjectConfig> {
    return this.request('PUT', `/projects/${encodeURIComponent(id)}`, body);
  }

  deleteProject(
    id: string,
    options: { force?: boolean } = {},
  ): Promise<{ id: string; name: string }> {
    const query = options.force ? '?force=true' : '';
    return this.request('DELETE', `/projects/${encodeURIComponent(id)}${query}`);
  }

  startProject(id: string): Promise<RuntimeSnapshot> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/start`);
  }

  stopProject(id: string): Promise<RuntimeSnapshot> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/stop`);
  }

  restartProject(id: string): Promise<RuntimeSnapshot> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/restart`);
  }

  getStatus(id: string): Promise<RuntimeSnapshot> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}/status`);
  }

  getLogs(id: string, tail = 200, instanceId?: string): Promise<LogsResponse> {
    const query = new URLSearchParams({ tail: String(tail) });
    if (instanceId) {
      query.set('instanceId', instanceId);
    }
    return this.request('GET', `/projects/${encodeURIComponent(id)}/logs?${query.toString()}`);
  }

  getInstances(id: string, limit = 20): Promise<ProjectInstance[]> {
    return this.request(
      'GET',
      `/projects/${encodeURIComponent(id)}/instances?limit=${String(limit)}`,
    );
  }

  getProjectEvents(id: string, limit = 50): Promise<SystemEventDto[]> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}/events?limit=${String(limit)}`);
  }

  getEvents(options: { projectId?: string; limit?: number } = {}): Promise<SystemEventDto[]> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.projectId) {
      query.set('projectId', options.projectId);
    }
    return this.request('GET', `/events?${query.toString()}`);
  }

  bulkStart(projectIds: string[]): Promise<BulkResponse> {
    return this.request('POST', '/bulk/start', { projectIds });
  }

  bulkStop(projectIds: string[]): Promise<BulkResponse> {
    return this.request('POST', '/bulk/stop', { projectIds });
  }

  detect(directory: string): Promise<DetectProjectResponse> {
    return this.request('POST', '/projects/detect', { directory });
  }

  scanRoot(directory: string): Promise<ScanRootResponse> {
    return this.request('POST', '/projects/scan-root', { directory });
  }

  getSettings(): Promise<EngineSettings> {
    return this.request('GET', '/settings');
  }

  updateSettings(patch: Partial<EngineSettings>): Promise<EngineSettings> {
    return this.request('PUT', '/settings', patch);
  }

  health(): Promise<HealthDto> {
    return this.request('GET', '/health');
  }

  getInfo(): Promise<EngineInfo> {
    return this.request('GET', '/info');
  }

  createBackup(): Promise<BackupInfo> {
    return this.request('POST', '/system/backup');
  }

  listBackups(): Promise<BackupInfo[]> {
    return this.request('GET', '/system/backups');
  }

  requestRestore(file: string): Promise<RestoreRequestResult> {
    return this.request('POST', '/system/restore', { file });
  }

  listGroups(): Promise<ProjectGroup[]> {
    return this.request('GET', '/groups');
  }

  createGroup(body: CreateGroupRequest): Promise<ProjectGroup> {
    return this.request('POST', '/groups', body);
  }

  updateGroup(id: string, body: UpdateGroupRequest): Promise<ProjectGroup> {
    return this.request('PUT', `/groups/${encodeURIComponent(id)}`, body);
  }

  deleteGroup(id: string): Promise<{ id: string; name: string }> {
    return this.request('DELETE', `/groups/${encodeURIComponent(id)}`);
  }

  startGroup(id: string): Promise<BulkResponse> {
    return this.request('POST', `/groups/${encodeURIComponent(id)}/start`);
  }

  stopGroup(id: string): Promise<BulkResponse> {
    return this.request('POST', `/groups/${encodeURIComponent(id)}/stop`);
  }

  restartGroup(id: string): Promise<BulkResponse> {
    return this.request('POST', `/groups/${encodeURIComponent(id)}/restart`);
  }

  getDomains(): Promise<DomainsOverview> {
    return this.request('GET', '/domains');
  }

  createDomain(body: {
    host: string;
    projectId: string;
    port?: number | null;
  }): Promise<DomainRoute> {
    return this.request('POST', '/domains', body);
  }

  updateDomain(id: string, body: { host?: string; port?: number | null }): Promise<DomainRoute> {
    return this.request('PUT', `/domains/${encodeURIComponent(id)}`, body);
  }

  deleteDomain(id: string): Promise<{ id: string; host: string }> {
    return this.request('DELETE', `/domains/${encodeURIComponent(id)}`);
  }

  syncDomainHosts(): Promise<HostsSyncResult> {
    return this.request('POST', '/domains/hosts/sync', {});
  }

  trustDomainCa(): Promise<DomainsStatus> {
    return this.request('POST', '/domains/ca/trust', {});
  }

  getSystemTools(): Promise<SystemTools> {
    return this.request('GET', '/system/tools');
  }

  getPostgresInfo(id: string): Promise<PostgresConnectionInfo> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}/postgres`);
  }

  backupPostgres(id: string): Promise<PostgresBackupResult> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/backup`, {});
  }

  getAuthStatus(): Promise<WebAuthStatus> {
    return this.request('GET', '/auth/status');
  }

  setupWebAuth(password: string): Promise<WebAuthStatus> {
    return this.request('POST', '/auth/setup', { password });
  }

  loginWeb(password: string): Promise<WebAuthStatus> {
    return this.request('POST', '/auth/login', { password });
  }

  logoutWeb(): Promise<WebAuthStatus> {
    return this.request('POST', '/auth/logout', {});
  }

  exportProjects(): Promise<ExportBundle> {
    return this.request('GET', '/projects/export');
  }

  importProjects(bundle: unknown): Promise<ImportConfigResponse> {
    return this.request('POST', '/projects/import-config', bundle);
  }

  getNodeVersions(): Promise<NodeInstallation[]> {
    return this.request('GET', '/system/node-versions');
  }

  getLaunchPreview(id: string): Promise<LaunchPreview> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}/launch-preview`);
  }

  buildProject(id: string): Promise<BuildResult> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/build`, {});
  }

  listTunnels(): Promise<TunnelSummary[]> {
    return this.request('GET', '/tunnels');
  }

  createTunnel(body: CreateTunnelRequest): Promise<TunnelSummary> {
    return this.request('POST', '/tunnels', body);
  }

  updateTunnel(id: string, body: UpdateTunnelRequest): Promise<TunnelSummary> {
    return this.request('PUT', `/tunnels/${encodeURIComponent(id)}`, body);
  }

  deleteTunnel(id: string): Promise<{ id: string; name: string }> {
    return this.request('DELETE', `/tunnels/${encodeURIComponent(id)}`);
  }

  startTunnel(id: string): Promise<TunnelStatus> {
    return this.request('POST', `/tunnels/${encodeURIComponent(id)}/start`, {});
  }

  stopTunnel(id: string): Promise<TunnelStatus> {
    return this.request('POST', `/tunnels/${encodeURIComponent(id)}/stop`, {});
  }

  restartTunnel(id: string): Promise<TunnelStatus> {
    return this.request('POST', `/tunnels/${encodeURIComponent(id)}/restart`, {});
  }

  getTunnelLogs(id: string, tail = 200): Promise<{ records: LogRecord[] }> {
    return this.request('GET', `/tunnels/${encodeURIComponent(id)}/logs?tail=${String(tail)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.endpoint.token !== '') {
      headers.authorization = `Bearer ${this.endpoint.token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const csrf = readCookie('lsm_csrf');
    if (csrf !== null && method !== 'GET' && method !== 'HEAD') {
      headers['x-csrf-token'] = csrf;
    }

    let response: Response;
    try {
      response = await fetch(`${this.endpoint.baseUrl}/api/v1${path}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(
        'NETWORK_ERROR',
        'Não foi possível falar com o Engine. Verifique se ele está em execução.',
        error,
      );
    }

    let envelope: OperationResult<T>;
    try {
      envelope = (await response.json()) as OperationResult<T>;
    } catch {
      throw new ApiError(
        'INVALID_RESPONSE',
        `Resposta inválida do Engine (HTTP ${String(response.status)})`,
      );
    }

    if (!envelope.success) {
      throw new ApiError(envelope.error.code, envelope.error.message, envelope.error.details);
    }
    return envelope.data;
  }
}

export type { DomainEvent, LogRecord };
