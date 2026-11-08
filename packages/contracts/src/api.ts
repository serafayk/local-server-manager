import type {
  DependencyWait,
  HealthCheckConfig,
  LaunchMode,
  LoggingConfig,
  PortSource,
  ProjectConfig,
  RestartPolicy,
  RuntimeConfig,
  ServeMode,
  ShutdownConfig,
} from './config';
import type { RuntimeSnapshot, ProjectStatus } from './domain';

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

/** Resultado de subir/parar uma stack (grupo + dependências). */
export interface StackRunResult {
  /** Níveis de execução na ordem aplicada (paralelo dentro do nível). */
  levels: string[][];
  results: BulkProjectResult[];
  /** Projetos não executados porque uma dependência falhou. */
  skipped: Array<{ projectId: string; reason: string }>;
}

/** Rota de domínio local (ex.: `api.uai.lsm`) apontando para um projeto. */
export interface DomainRoute {
  id: string;
  host: string;
  projectId: string;
  projectName: string;
  projectStatus: ProjectStatus;
  /** Porta fixa da rota; `null` usa a porta do projeto. */
  port: number | null;
  /** Porta efetivamente usada pelo proxy (null = projeto sem porta). */
  upstreamPort: number | null;
  urls: {
    http: string;
    https: string;
    /** Alias `.localhost` que resolve sem editar o arquivo hosts. */
    localhost: string;
  };
  /** `true` quando o host `.lsm` já está no arquivo hosts. */
  hostsSynced: boolean;
}

export interface DomainCertificateStatus {
  exists: boolean;
  trusted: boolean;
  path: string | null;
}

export interface DomainsStatus {
  httpPort: number;
  httpsPort: number;
  httpListening: boolean;
  httpsListening: boolean;
  certificate: DomainCertificateStatus;
  hostsFile: string;
  pendingHosts: string[];
  /** Motivo quando o proxy não pôde subir (porta ocupada, por exemplo). */
  proxyError: string | null;
}

export interface DomainsOverview {
  routes: DomainRoute[];
  status: DomainsStatus;
}

export interface CreateDomainRequest {
  host: string;
  projectId: string;
  port?: number | null;
}

export interface UpdateDomainRequest {
  host?: string;
  port?: number | null;
}

export interface HostsSyncResult {
  applied: string[];
  pending: string[];
  error: string | null;
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

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

export interface CreateGroupRequest {
  name: string;
  sortOrder?: number;
}

export interface UpdateGroupRequest {
  name?: string;
  sortOrder?: number;
}

export interface ExportedDependency {
  project: string;
  waitFor: DependencyWait;
}

export interface ExportedProject {
  name: string;
  description: string | null;
  group: string | null;
  workingDirectory: string;
  runtime: RuntimeConfig;
  environment: Record<string, string>;
  maskedEnvironmentKeys: string[];
  port: number | null;
  portSource: PortSource;
  launchMode: LaunchMode;
  serveMode: ServeMode;
  outputDir: string | null;
  /** Referências por **nome** de projeto (IDs não são portáveis entre máquinas). */
  dependsOn: ExportedDependency[];
  dependencyTimeoutMs: number;
  enabled: boolean;
  startOnBoot: boolean;
  startupOrder: number;
  restartPolicy: RestartPolicy;
  healthCheck: HealthCheckConfig;
  logging: LoggingConfig;
  shutdown: ShutdownConfig;
}

export interface ExportBundle {
  schemaVersion: number;
  exportedAt: string;
  projects: ExportedProject[];
}

export interface ImportConfigResult {
  name: string;
  success: boolean;
  errorCode?: string;
  message?: string;
}

export interface ImportConfigResponse {
  results: ImportConfigResult[];
}

export interface NodeInstallation {
  version: string;
  executable: string;
  source: 'nvm' | 'system' | 'engine' | 'path';
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

/** Origem da porta detectada ao varrer a raiz de um repositório. */
export type ScanPortSource = 'env' | 'config' | 'script' | 'none';

/**
 * Candidato a projeto encontrado em uma varredura da raiz do repositório.
 * Tudo aqui é sugestão editável; nada é criado sem confirmação.
 */
export interface ScannedProject {
  name: string;
  packageName: string | null;
  directory: string;
  relativeDirectory: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** Script escolhido automaticamente (`start`, `dev` ou o primeiro disponível). */
  script: string | null;
  availableScripts: string[];
  runnable: boolean;
  /** Sugestão de seleção inicial na tela de revisão. */
  recommended: boolean;
  port: number | null;
  portSource: ScanPortSource;
  healthType: 'http' | 'tcp';
  healthTarget: string | null;
  startupOrder: number;
  notes: string[];
}

export interface ScanRootResponse {
  root: string;
  isMonorepo: boolean;
  groupSuggestion: string;
  projects: ScannedProject[];
}

/** Prévia de como o Engine lançaria o projeto (sem iniciar nada). */
export interface LaunchPreview {
  mode: 'direct' | 'wrapper';
  executable: string;
  args: string[];
  cwd: string;
  reason: string | null;
  skippedProcesses: number;
  script: string | null;
  appDirectory: string | null;
}

export interface BuildResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  instanceId: string;
}

export interface ImportProjectRequest {
  directory: string;
  name?: string;
  script?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  executable?: string;
  args?: string[];
  port?: number | null;
  startOnBoot?: boolean;
  environment?: Record<string, string>;
  enabled?: boolean;
  startupOrder?: number;
  restartPolicy?: Partial<RestartPolicy>;
  healthCheck?: Partial<HealthCheckConfig>;
  logging?: Partial<LoggingConfig>;
  shutdown?: Partial<ShutdownConfig>;
}

/** Instância de processo exposta pela API (histórico). */
export interface ProjectInstance {
  id: string;
  projectId: string;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  terminationReason: string | null;
  status: ProjectStatus;
  createdAt: string;
}
