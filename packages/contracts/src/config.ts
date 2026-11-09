/**
 * Modelo de configuração de projeto — docs/05-PROJECT-CONFIGURATION.md.
 *
 * Diferenças deliberadas em relação ao exemplo do documento:
 * - `runtime.executable` + `runtime.args` substituem `command`, que era
 *   apenas exibição. Não existe forma de configurar shell.
 * - `port`/`portSource` foram adicionados (ADR-010, I-1).
 * - `startupOrder` foi adicionado para início determinístico (ADR-010, I-3).
 */
export type PortSource = 'none' | 'fixed' | 'env' | 'detected';

export const PORT_SOURCES = ['none', 'fixed', 'env', 'detected'] as const;

/** Como o LSM lança o processo: direto (sem wrappers) ou pelo script do package manager. */
export type LaunchMode = 'auto' | 'wrapper' | 'direct';

export const LAUNCH_MODES = ['auto', 'wrapper', 'direct'] as const;

/** Como o serviço é servido: processo próprio ou arquivos estáticos pelo Engine. */
export type ServeMode = 'process' | 'static';

export const SERVE_MODES = ['process', 'static'] as const;

/** Tipo de projeto gerenciado: app Node, processo genérico, stack Compose ou Postgres dedicado. */
export type ProjectKind = 'node' | 'process' | 'compose' | 'postgres';

export const PROJECT_KINDS = ['node', 'process', 'compose', 'postgres'] as const;

export interface ComposeServiceConfig {
  /** Caminho do docker-compose.yml (absoluto ou relativo ao workingDirectory). */
  file: string;
  /** Nome do projeto Compose (`-p`); null usa o nome do diretório. */
  projectName: string | null;
  /** Executável do Docker; null usa `docker` do PATH. */
  dockerExecutable: string | null;
}

export interface PostgresServiceConfig {
  /** Versão/rótulo da instalação (ex.: "16"); null detecta automaticamente. */
  version: string | null;
  /** Pasta `bin` da instalação; null detecta automaticamente. */
  binDir: string | null;
  /** Data dir; null usa `<dados do Engine>/postgres/<projectId>`. */
  dataDir: string | null;
  username: string;
  password: string;
  /** Porta do servidor; null usa 55432. */
  port: number | null;
}

/** Critério para considerar uma dependência pronta para liberar o dependente. */
export type DependencyWait = 'started' | 'ready';

export const DEPENDENCY_WAITS = ['started', 'ready'] as const;

export interface ProjectDependency {
  projectId: string;
  /** `started` aguarda o processo iniciar; `ready` aguarda o health check. */
  waitFor: DependencyWait;
}

export interface RestartPolicy {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  stableAfterMs: number;
  resetRetriesAfterStable: boolean;
}

export type HealthCheckType = 'http' | 'tcp';

export interface HealthCheckConfig {
  enabled: boolean;
  type: HealthCheckType;
  target: string;
  expectedStatus: number;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
  restartOnUnhealthy: boolean;
  unhealthyRestartCooldownMs: number;
}

export interface LoggingConfig {
  maxFileSizeMb: number;
  retentionDays: number;
  captureOutput: boolean;
  maskPatterns: string[];
}

export interface ShutdownConfig {
  gracefulTimeoutMs: number;
}

export interface RuntimeConfig {
  /** Executável absoluto ou nome resolvível no PATH (nunca uma linha de shell). */
  executable: string;
  args: string[];
}

export interface ProjectConfig {
  id: string;
  name: string;
  description: string | null;
  groupId: string | null;
  enabled: boolean;
  startOnBoot: boolean;
  startupOrder: number;
  workingDirectory: string;
  runtime: RuntimeConfig;
  /** `auto` tenta lançamento direto; `wrapper` mantém pnpm/npm; `direct` exige direto. */
  launchMode: LaunchMode;
  /** `process` sobe um processo; `static` serve arquivos pelo Engine. */
  serveMode: ServeMode;
  /** Diretório servido no modo estático (relativo à raiz do projeto ou absoluto). */
  outputDir: string | null;
  /** Tipo do projeto; `node` mantém o comportamento histórico. */
  kind: ProjectKind;
  compose: ComposeServiceConfig | null;
  postgres: PostgresServiceConfig | null;
  /** Executado antes de encerrar o processo (ex.: `php bin/robot --stop`). */
  stopCommand: RuntimeConfig | null;
  environment: Record<string, string>;
  /** Projetos que precisam estar prontos antes deste. */
  dependsOn: ProjectDependency[];
  /** Tempo máximo aguardando cada dependência (ms). */
  dependencyTimeoutMs: number;
  port: number | null;
  portSource: PortSource;
  restartPolicy: RestartPolicy;
  healthCheck: HealthCheckConfig;
  logging: LoggingConfig;
  shutdown: ShutdownConfig;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export const CURRENT_CONFIG_SCHEMA_VERSION = 5;
