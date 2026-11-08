import type {
  BulkProjectResult,
  DetectProjectResponse,
  DomainEvent,
  EngineInfo,
  EngineSettings,
  ErrorCode,
  LogRecord,
  OperationResult,
  ProjectConfig,
  ProjectInstance,
  ProjectSummary,
  RuntimeSnapshot,
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

  deleteProject(id: string): Promise<{ id: string; name: string }> {
    return this.request('DELETE', `/projects/${encodeURIComponent(id)}`);
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.endpoint.token}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(`${this.endpoint.baseUrl}/api/v1${path}`, {
        method,
        headers,
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
