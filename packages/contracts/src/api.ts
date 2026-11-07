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

export interface EngineApiInfo {
  host: string;
  port: number;
  baseUrl: string;
  token: string;
  websocketPath: string;
}

export interface EngineInfo {
  pid: number;
  protocolVersion: number;
  dataDir: string;
  startedAt: string;
  projects: number;
  api: EngineApiInfo | null;
}

export interface DetectProjectRequest {
  directory: string;
}

export interface DetectedScript {
  name: string;
  command: string;
}

export interface DetectProjectResponse {
  directory: string;
  hasPackageJson: boolean;
  projectName: string | null;
  scripts: DetectedScript[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  lockfile: string | null;
  packageManagerConfirmed: boolean;
}

export interface ImportProjectRequest {
  directory: string;
  name?: string;
  script?: string;
  executable?: string;
  args?: string[];
  port?: number | null;
  startOnBoot?: boolean;
  environment?: Record<string, string>;
}
