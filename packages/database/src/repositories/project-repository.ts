import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  HealthCheckConfig,
  HealthCheckType,
  ProjectConfig,
  ProjectDependency,
  RestartPolicy,
  RuntimeConfig,
  LoggingConfig,
  ShutdownConfig,
} from '@lsm/contracts';
import { AppError } from '@lsm/shared';
import { parseProjectConfig } from '@lsm/validation';
import { fromSqlBool, parseJsonColumn, toSqlBool, transaction } from '../connection';

interface ProjectJoinRow {
  id: string;
  name: string;
  description: string | null;
  group_id: string | null;
  working_directory: string;
  runtime_json: string;
  environment_json: string;
  launch_mode: string;
  serve_mode: string;
  output_dir: string | null;
  depends_on_json: string;
  dependency_timeout_ms: number;
  port: number | null;
  port_source: string;
  enabled: number;
  start_on_boot: number;
  startup_order: number;
  logging_json: string;
  shutdown_json: string;
  config_schema_version: number;
  created_at: string;
  updated_at: string;
  r_enabled: number;
  r_max_retries: number;
  r_base_delay_ms: number;
  r_max_delay_ms: number;
  r_jitter_ratio: number;
  r_stable_after_ms: number;
  r_reset_after_stable: number;
  h_enabled: number;
  h_type: string;
  h_target: string;
  h_expected_status: number;
  h_interval_ms: number;
  h_timeout_ms: number;
  h_failure_threshold: number;
  h_restart_on_unhealthy: number;
  h_unhealthy_restart_cooldown_ms: number;
}

const SELECT_PROJECT = `
SELECT
  p.id, p.name, p.description, p.group_id, p.working_directory, p.runtime_json,
  p.environment_json, p.launch_mode, p.serve_mode, p.output_dir,
  p.depends_on_json, p.dependency_timeout_ms,
  p.port, p.port_source, p.enabled, p.start_on_boot, p.startup_order,
  p.logging_json, p.shutdown_json, p.config_schema_version, p.created_at, p.updated_at,
  r.enabled AS r_enabled,
  r.max_retries AS r_max_retries,
  r.base_delay_ms AS r_base_delay_ms,
  r.max_delay_ms AS r_max_delay_ms,
  r.jitter_ratio AS r_jitter_ratio,
  r.stable_after_ms AS r_stable_after_ms,
  r.reset_after_stable AS r_reset_after_stable,
  h.enabled AS h_enabled,
  h.type AS h_type,
  h.target AS h_target,
  h.expected_status AS h_expected_status,
  h.interval_ms AS h_interval_ms,
  h.timeout_ms AS h_timeout_ms,
  h.failure_threshold AS h_failure_threshold,
  h.restart_on_unhealthy AS h_restart_on_unhealthy,
  h.unhealthy_restart_cooldown_ms AS h_unhealthy_restart_cooldown_ms
FROM projects p
JOIN restart_policies r ON r.project_id = p.id
JOIN health_checks h ON h.project_id = p.id
`;

const INSERT_PROJECT = `
INSERT INTO projects (
  id, name, description, group_id, working_directory, runtime_json, environment_json,
  launch_mode, serve_mode, output_dir, depends_on_json, dependency_timeout_ms,
  port, port_source, enabled, start_on_boot, startup_order, logging_json, shutdown_json,
  config_schema_version, created_at, updated_at
) VALUES (
  $id, $name, $description, $groupId, $workingDirectory, $runtimeJson, $environmentJson,
  $launchMode, $serveMode, $outputDir, $dependsOnJson, $dependencyTimeoutMs,
  $port, $portSource, $enabled, $startOnBoot, $startupOrder, $loggingJson, $shutdownJson,
  $schemaVersion, $createdAt, $updatedAt
)
`;

const UPSERT_POLICY = `
INSERT INTO restart_policies (
  project_id, enabled, max_retries, base_delay_ms, max_delay_ms, jitter_ratio,
  stable_after_ms, reset_after_stable
) VALUES (
  $projectId, $enabled, $maxRetries, $baseDelayMs, $maxDelayMs, $jitterRatio,
  $stableAfterMs, $resetAfterStable
)
ON CONFLICT(project_id) DO UPDATE SET
  enabled = excluded.enabled,
  max_retries = excluded.max_retries,
  base_delay_ms = excluded.base_delay_ms,
  max_delay_ms = excluded.max_delay_ms,
  jitter_ratio = excluded.jitter_ratio,
  stable_after_ms = excluded.stable_after_ms,
  reset_after_stable = excluded.reset_after_stable
`;

const UPSERT_HEALTH = `
INSERT INTO health_checks (
  project_id, enabled, type, target, expected_status, interval_ms, timeout_ms,
  failure_threshold, restart_on_unhealthy, unhealthy_restart_cooldown_ms
) VALUES (
  $projectId, $enabled, $type, $target, $expectedStatus, $intervalMs, $timeoutMs,
  $failureThreshold, $restartOnUnhealthy, $unhealthyRestartCooldownMs
)
ON CONFLICT(project_id) DO UPDATE SET
  enabled = excluded.enabled,
  type = excluded.type,
  target = excluded.target,
  expected_status = excluded.expected_status,
  interval_ms = excluded.interval_ms,
  timeout_ms = excluded.timeout_ms,
  failure_threshold = excluded.failure_threshold,
  restart_on_unhealthy = excluded.restart_on_unhealthy,
  unhealthy_restart_cooldown_ms = excluded.unhealthy_restart_cooldown_ms
`;

function mapRow(row: ProjectJoinRow): ProjectConfig {
  try {
    const runtime = parseJsonColumn<RuntimeConfig>(row.runtime_json, 'runtime_json');
    const environment = parseJsonColumn<Record<string, string>>(
      row.environment_json,
      'environment_json',
    );
    const logging = parseJsonColumn<LoggingConfig>(row.logging_json, 'logging_json');
    const shutdown = parseJsonColumn<ShutdownConfig>(row.shutdown_json, 'shutdown_json');
    const dependsOn = parseJsonColumn<ProjectDependency[]>(row.depends_on_json, 'depends_on_json');

    const restartPolicy: RestartPolicy = {
      enabled: fromSqlBool(row.r_enabled),
      maxRetries: row.r_max_retries,
      baseDelayMs: row.r_base_delay_ms,
      maxDelayMs: row.r_max_delay_ms,
      jitterRatio: row.r_jitter_ratio,
      stableAfterMs: row.r_stable_after_ms,
      resetRetriesAfterStable: fromSqlBool(row.r_reset_after_stable),
    };

    const healthCheck: HealthCheckConfig = {
      enabled: fromSqlBool(row.h_enabled),
      type: row.h_type as HealthCheckType,
      target: row.h_target,
      expectedStatus: row.h_expected_status,
      intervalMs: row.h_interval_ms,
      timeoutMs: row.h_timeout_ms,
      failureThreshold: row.h_failure_threshold,
      restartOnUnhealthy: fromSqlBool(row.h_restart_on_unhealthy),
      unhealthyRestartCooldownMs: row.h_unhealthy_restart_cooldown_ms,
    };

    return parseProjectConfig({
      id: row.id,
      name: row.name,
      description: row.description,
      groupId: row.group_id,
      workingDirectory: row.working_directory,
      runtime,
      launchMode: row.launch_mode as ProjectConfig['launchMode'],
      serveMode: row.serve_mode as ProjectConfig['serveMode'],
      outputDir: row.output_dir,
      dependsOn,
      dependencyTimeoutMs: row.dependency_timeout_ms,
      environment,
      port: row.port,
      portSource: row.port_source,
      enabled: fromSqlBool(row.enabled),
      startOnBoot: fromSqlBool(row.start_on_boot),
      startupOrder: row.startup_order,
      restartPolicy,
      healthCheck,
      logging,
      shutdown,
      schemaVersion: row.config_schema_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      'STORAGE_ERROR',
      `Projeto ${row.id} contém configuração inválida`,
      undefined,
      {
        cause: error,
      },
    );
  }
}

function isUniqueNameViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: projects\.name/i.test(error.message);
}

export class SqliteProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(config: ProjectConfig): void {
    try {
      transaction(this.db, () => {
        this.db.prepare(INSERT_PROJECT).run(this.toProjectParams(config));
        this.db.prepare(UPSERT_POLICY).run(this.toPolicyParams(config));
        this.db.prepare(UPSERT_HEALTH).run(this.toHealthParams(config));
      });
    } catch (error) {
      if (isUniqueNameViolation(error)) {
        throw new AppError(
          'PROJECT_NAME_IN_USE',
          `Já existe um projeto com o nome "${config.name}"`,
        );
      }
      throw error;
    }
  }

  update(config: ProjectConfig): void {
    try {
      transaction(this.db, () => {
        const result = this.db
          .prepare(
            `UPDATE projects SET
              name = $name, description = $description, group_id = $groupId,
              working_directory = $workingDirectory, runtime_json = $runtimeJson,
              environment_json = $environmentJson,
              launch_mode = $launchMode, serve_mode = $serveMode, output_dir = $outputDir,
              depends_on_json = $dependsOnJson, dependency_timeout_ms = $dependencyTimeoutMs,
              port = $port, port_source = $portSource,
              enabled = $enabled, start_on_boot = $startOnBoot, startup_order = $startupOrder,
              logging_json = $loggingJson, shutdown_json = $shutdownJson,
              config_schema_version = $schemaVersion, updated_at = $updatedAt
            WHERE id = $id`,
          )
          .run({
            id: config.id,
            name: config.name,
            description: config.description,
            groupId: config.groupId,
            workingDirectory: config.workingDirectory,
            runtimeJson: JSON.stringify(config.runtime),
            environmentJson: JSON.stringify(config.environment),
            launchMode: config.launchMode,
            serveMode: config.serveMode,
            outputDir: config.outputDir,
            dependsOnJson: JSON.stringify(config.dependsOn),
            dependencyTimeoutMs: config.dependencyTimeoutMs,
            port: config.port,
            portSource: config.portSource,
            enabled: toSqlBool(config.enabled),
            startOnBoot: toSqlBool(config.startOnBoot),
            startupOrder: config.startupOrder,
            loggingJson: JSON.stringify(config.logging),
            shutdownJson: JSON.stringify(config.shutdown),
            schemaVersion: config.schemaVersion,
            updatedAt: config.updatedAt,
          });
        if (result.changes === 0) {
          throw new AppError('PROJECT_NOT_FOUND', `Projeto ${config.id} não encontrado`);
        }
        this.db.prepare(UPSERT_POLICY).run(this.toPolicyParams(config));
        this.db.prepare(UPSERT_HEALTH).run(this.toHealthParams(config));
      });
    } catch (error) {
      if (isUniqueNameViolation(error)) {
        throw new AppError(
          'PROJECT_NAME_IN_USE',
          `Já existe um projeto com o nome "${config.name}"`,
        );
      }
      throw error;
    }
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  findById(id: string): ProjectConfig | null {
    const row = this.db.prepare(`${SELECT_PROJECT} WHERE p.id = ?`).get(id) as unknown as
      ProjectJoinRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByName(name: string): ProjectConfig | null {
    const row = this.db
      .prepare(`${SELECT_PROJECT} WHERE p.name = ? COLLATE NOCASE`)
      .get(name) as unknown as ProjectJoinRow | undefined;
    return row ? mapRow(row) : null;
  }

  list(): ProjectConfig[] {
    const rows = this.db
      .prepare(`${SELECT_PROJECT} ORDER BY p.startup_order ASC, p.name COLLATE NOCASE ASC`)
      .all() as unknown as ProjectJoinRow[];
    return rows.map(mapRow);
  }

  listBootProjects(): ProjectConfig[] {
    const rows = this.db
      .prepare(
        `${SELECT_PROJECT}
         WHERE p.enabled = 1 AND p.start_on_boot = 1
         ORDER BY p.startup_order ASC, p.name COLLATE NOCASE ASC`,
      )
      .all() as unknown as ProjectJoinRow[];
    return rows.map(mapRow);
  }

  private toProjectParams(config: ProjectConfig): Record<string, SQLInputValue> {
    return {
      id: config.id,
      name: config.name,
      description: config.description,
      groupId: config.groupId,
      workingDirectory: config.workingDirectory,
      runtimeJson: JSON.stringify(config.runtime),
      environmentJson: JSON.stringify(config.environment),
      launchMode: config.launchMode,
      serveMode: config.serveMode,
      outputDir: config.outputDir,
      dependsOnJson: JSON.stringify(config.dependsOn),
      dependencyTimeoutMs: config.dependencyTimeoutMs,
      port: config.port,
      portSource: config.portSource,
      enabled: toSqlBool(config.enabled),
      startOnBoot: toSqlBool(config.startOnBoot),
      startupOrder: config.startupOrder,
      loggingJson: JSON.stringify(config.logging),
      shutdownJson: JSON.stringify(config.shutdown),
      schemaVersion: config.schemaVersion,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  private toPolicyParams(config: ProjectConfig): Record<string, SQLInputValue> {
    const policy = config.restartPolicy;
    return {
      projectId: config.id,
      enabled: toSqlBool(policy.enabled),
      maxRetries: policy.maxRetries,
      baseDelayMs: policy.baseDelayMs,
      maxDelayMs: policy.maxDelayMs,
      jitterRatio: policy.jitterRatio,
      stableAfterMs: policy.stableAfterMs,
      resetAfterStable: toSqlBool(policy.resetRetriesAfterStable),
    };
  }

  private toHealthParams(config: ProjectConfig): Record<string, SQLInputValue> {
    const health = config.healthCheck;
    return {
      projectId: config.id,
      enabled: toSqlBool(health.enabled),
      type: health.type,
      target: health.target,
      expectedStatus: health.expectedStatus,
      intervalMs: health.intervalMs,
      timeoutMs: health.timeoutMs,
      failureThreshold: health.failureThreshold,
      restartOnUnhealthy: toSqlBool(health.restartOnUnhealthy),
      unhealthyRestartCooldownMs: health.unhealthyRestartCooldownMs,
    };
  }
}
