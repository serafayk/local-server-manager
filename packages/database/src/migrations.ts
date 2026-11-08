export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migração v1 — schema de docs/07-DATABASE.md com as correções registradas
 * no ADR-010:
 * - `port`/`port_source` (I-1)
 * - `startup_order`, `logging_json`, `shutdown_json` (I-3)
 * - `jitter_ratio`, `unhealthy_restart_cooldown_ms` (I-4)
 * - `pid_started_at` anti-reuso de PID (I-5)
 * - CHECK de status de instância (I-6)
 * - FK de `group_id` (I-7)
 * - `schema_migrations` criada pelo migrator (I-2)
 */
export const MIGRATION_001: Migration = {
  version: 1,
  name: 'initial-schema',
  sql: `
CREATE TABLE project_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT,
  group_id TEXT REFERENCES project_groups(id) ON DELETE SET NULL,
  working_directory TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  port INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  port_source TEXT NOT NULL DEFAULT 'none'
    CHECK (port_source IN ('none', 'fixed', 'env', 'detected')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  start_on_boot INTEGER NOT NULL DEFAULT 0 CHECK (start_on_boot IN (0, 1)),
  startup_order INTEGER NOT NULL DEFAULT 0,
  logging_json TEXT NOT NULL,
  shutdown_json TEXT NOT NULL,
  config_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE restart_policies (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  max_retries INTEGER NOT NULL CHECK (max_retries >= 0),
  base_delay_ms INTEGER NOT NULL CHECK (base_delay_ms > 0),
  max_delay_ms INTEGER NOT NULL CHECK (max_delay_ms >= base_delay_ms),
  jitter_ratio REAL NOT NULL DEFAULT 0 CHECK (jitter_ratio >= 0 AND jitter_ratio <= 1),
  stable_after_ms INTEGER NOT NULL CHECK (stable_after_ms >= 0),
  reset_after_stable INTEGER NOT NULL CHECK (reset_after_stable IN (0, 1))
);

CREATE TABLE health_checks (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  type TEXT NOT NULL CHECK (type IN ('http', 'tcp')),
  target TEXT NOT NULL,
  expected_status INTEGER NOT NULL DEFAULT 200,
  interval_ms INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  failure_threshold INTEGER NOT NULL,
  restart_on_unhealthy INTEGER NOT NULL DEFAULT 0,
  unhealthy_restart_cooldown_ms INTEGER NOT NULL DEFAULT 60000
);

CREATE TABLE process_instances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pid INTEGER,
  pid_started_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  exit_signal TEXT,
  termination_reason TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'CRASHED', 'RESTARTING', 'FAILED')
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE system_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  instance_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_process_instances_project_started
  ON process_instances (project_id, started_at);
CREATE INDEX idx_process_instances_status
  ON process_instances (status);
CREATE INDEX idx_system_events_project_created
  ON system_events (project_id, created_at);
CREATE INDEX idx_system_events_type_created
  ON system_events (event_type, created_at);
CREATE INDEX idx_system_events_created
  ON system_events (created_at);
CREATE INDEX idx_projects_group
  ON projects (group_id);
CREATE INDEX idx_projects_boot
  ON projects (start_on_boot, enabled, startup_order);
`,
};

export const MIGRATION_002: Migration = {
  version: 2,
  name: 'tunnels',
  sql: `
CREATE TABLE tunnels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('config', 'token', 'quick')),
  config_path TEXT,
  target_port INTEGER CHECK (target_port IS NULL OR (target_port BETWEEN 1 AND 65535)),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  token TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  start_on_boot INTEGER NOT NULL DEFAULT 0 CHECK (start_on_boot IN (0, 1)),
  metrics_port INTEGER CHECK (metrics_port IS NULL OR (metrics_port BETWEEN 1024 AND 65535)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_tunnels_boot ON tunnels (start_on_boot, enabled);
CREATE INDEX idx_tunnels_project ON tunnels (project_id);
`,
};

export const MIGRATION_003: Migration = {
  version: 3,
  name: 'launch-and-serve-modes',
  sql: `
ALTER TABLE projects ADD COLUMN launch_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (launch_mode IN ('auto', 'wrapper', 'direct'));

ALTER TABLE projects ADD COLUMN serve_mode TEXT NOT NULL DEFAULT 'process'
  CHECK (serve_mode IN ('process', 'static'));

ALTER TABLE projects ADD COLUMN output_dir TEXT;
`,
};

export const MIGRATION_004: Migration = {
  version: 4,
  name: 'project-dependencies',
  sql: `
ALTER TABLE projects ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE projects ADD COLUMN dependency_timeout_ms INTEGER NOT NULL DEFAULT 60000;
`,
};

export const MIGRATION_005: Migration = {
  version: 5,
  name: 'local-domains',
  sql: `
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL COLLATE NOCASE UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  port INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_domains_project ON domains (project_id);
`,
};

export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
];
