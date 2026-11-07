import type {
  HealthCheckConfig,
  LoggingConfig,
  PortSource,
  ProjectConfig,
  RestartPolicy,
  RuntimeConfig,
  ShutdownConfig,
} from './config';
import type { RuntimeSnapshot } from './domain';

/**
 * DTOs de entrada da API local (Fase 3). A Fase 1 já usa os mesmos formatos
 * na CLI de desenvolvimento, para não divergir do contrato final.
 */
export interface CreateProjectRequest {
  name: string;
  description?: string | null;
  groupId?: string | null;
  workingDirectory: string;
  runtime: RuntimeConfig;
  environment?: Record<string, string>;
  port?: number | null;
  portSource?: PortSource;
  enabled?: boolean;
  startOnBoot?: boolean;
  startupOrder?: number;
  restartPolicy?: Partial<RestartPolicy>;
  healthCheck?: Partial<HealthCheckConfig>;
  logging?: Partial<LoggingConfig>;
  shutdown?: Partial<ShutdownConfig>;
}

export interface UpdateProjectRequest extends Omit<
  Partial<CreateProjectRequest>,
  'name' | 'workingDirectory' | 'runtime'
> {
  name?: string;
  workingDirectory?: string;
  runtime?: RuntimeConfig;
}

export interface BulkProjectsRequest {
  projectIds: string[];
}

export interface BulkProjectResult {
  projectId: string;
  success: boolean;
  errorCode?: string;
  message?: string;
}

export interface BulkProjectsResponse {
  results: BulkProjectResult[];
}

export interface ProjectSummary {
  config: ProjectConfig;
  runtime: RuntimeSnapshot;
}

export interface EngineInfo {
  pid: number;
  protocolVersion: number;
  dataDir: string;
  startedAt: string;
  projects: number;
}
