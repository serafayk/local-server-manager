import type { DatabaseSync } from 'node:sqlite';
import type { TunnelConfig, TunnelKind } from '@lsm/contracts';

interface TunnelRow {
  id: string;
  name: string;
  kind: TunnelKind;
  config_path: string | null;
  target_port: number | null;
  project_id: string | null;
  token: string | null;
  enabled: number;
  start_on_boot: number;
  metrics_port: number | null;
  created_at: string;
  updated_at: string;
}

function mapTunnel(row: TunnelRow): TunnelConfig {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    configPath: row.config_path,
    targetPort: row.target_port,
    projectId: row.project_id,
    enabled: row.enabled === 1,
    startOnBoot: row.start_on_boot === 1,
    metricsPort: row.metrics_port,
    hasToken: row.token !== null && row.token !== '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteTunnelRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(config: TunnelConfig, token: string | null): void {
    this.db
      .prepare(
        `INSERT INTO tunnels (
           id, name, kind, config_path, target_port, project_id, token,
           enabled, start_on_boot, metrics_port, created_at, updated_at
         ) VALUES (
           $id, $name, $kind, $configPath, $targetPort, $projectId, $token,
           $enabled, $startOnBoot, $metricsPort, $createdAt, $updatedAt
         )`,
      )
      .run({
        id: config.id,
        name: config.name,
        kind: config.kind,
        configPath: config.configPath,
        targetPort: config.targetPort,
        projectId: config.projectId,
        token,
        enabled: config.enabled ? 1 : 0,
        startOnBoot: config.startOnBoot ? 1 : 0,
        metricsPort: config.metricsPort,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      });
  }

  update(config: TunnelConfig, token: string | null | undefined): void {
    this.db
      .prepare(
        `UPDATE tunnels SET
           name = $name,
           kind = $kind,
           config_path = $configPath,
           target_port = $targetPort,
           project_id = $projectId,
           token = CASE WHEN $updateToken = 1 THEN $token ELSE token END,
           enabled = $enabled,
           start_on_boot = $startOnBoot,
           metrics_port = $metricsPort,
           updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({
        id: config.id,
        name: config.name,
        kind: config.kind,
        configPath: config.configPath,
        targetPort: config.targetPort,
        projectId: config.projectId,
        updateToken: token === undefined ? 0 : 1,
        token: token ?? null,
        enabled: config.enabled ? 1 : 0,
        startOnBoot: config.startOnBoot ? 1 : 0,
        metricsPort: config.metricsPort,
        updatedAt: config.updatedAt,
      });
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tunnels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  findById(id: string): TunnelConfig | null {
    const row = this.db.prepare('SELECT * FROM tunnels WHERE id = ?').get(id) as unknown as
      TunnelRow | undefined;
    return row ? mapTunnel(row) : null;
  }

  findByName(name: string): TunnelConfig | null {
    const row = this.db
      .prepare('SELECT * FROM tunnels WHERE name = ? COLLATE NOCASE')
      .get(name) as unknown as TunnelRow | undefined;
    return row ? mapTunnel(row) : null;
  }

  /** Leitura explícita do segredo; nunca incluído em `TunnelConfig`. */
  findToken(id: string): string | null {
    const row = this.db.prepare('SELECT token FROM tunnels WHERE id = ?').get(id) as unknown as
      { token: string | null } | undefined;
    return row?.token ?? null;
  }

  list(): TunnelConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM tunnels ORDER BY name COLLATE NOCASE ASC')
      .all() as unknown as TunnelRow[];
    return rows.map(mapTunnel);
  }

  listBoot(): TunnelConfig[] {
    const rows = this.db
      .prepare('SELECT * FROM tunnels WHERE start_on_boot = 1 AND enabled = 1 ORDER BY name')
      .all() as unknown as TunnelRow[];
    return rows.map(mapTunnel);
  }
}
