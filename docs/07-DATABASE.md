# 07 — Banco de dados SQLite

> **Status:** schema v1 implementado em `packages/database/src/migrations.ts`.
> As diferenças em relação à versão original da especificação estão no
> [ADR-010](14-ADR.md).

## 1. Localização

Armazenar dados em diretório de aplicação do usuário, por exemplo `%LOCALAPPDATA%/LocalServerManager/`.

Separar:

- `data/manager.sqlite`
- `logs/<projectId>/<instanceId>.log`
- `backups/`
- `engine/engine.log` e `engine/engine.json`

Não armazenar dados mutáveis dentro da pasta de instalação do aplicativo.

## 2. Tabelas

### schema_migrations

- `version INTEGER PRIMARY KEY`
- `name TEXT NOT NULL`
- `checksum TEXT NOT NULL` (SHA-256 do SQL)
- `applied_at TEXT NOT NULL`

Migrações rodam em transação individual. Checksum divergente é erro
(`STORAGE_ERROR`), nunca recriação silenciosa. Backup é feito antes de aplicar
migração pendente sobre banco já populado.

### projects

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL COLLATE NOCASE UNIQUE`
- `description TEXT`
- `group_id TEXT NULL REFERENCES project_groups(id) ON DELETE SET NULL`
- `working_directory TEXT NOT NULL`
- `runtime_json TEXT NOT NULL` (`{ executable, args }`)
- `environment_json TEXT NOT NULL`
- `port INTEGER NULL CHECK (1..65535)`
- `port_source TEXT NOT NULL` (`none|fixed|env|detected`)
- `enabled INTEGER NOT NULL` (`0|1`)
- `start_on_boot INTEGER NOT NULL` (`0|1`)
- `startup_order INTEGER NOT NULL DEFAULT 0`
- `logging_json TEXT NOT NULL`
- `shutdown_json TEXT NOT NULL`
- `config_schema_version INTEGER NOT NULL DEFAULT 1`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### project_groups

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `created_at TEXT NOT NULL`

### restart_policies

- `project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE`
- `enabled INTEGER NOT NULL`
- `max_retries INTEGER NOT NULL`
- `base_delay_ms INTEGER NOT NULL`
- `max_delay_ms INTEGER NOT NULL` (`CHECK max_delay_ms >= base_delay_ms`)
- `jitter_ratio REAL NOT NULL DEFAULT 0`
- `stable_after_ms INTEGER NOT NULL`
- `reset_after_stable INTEGER NOT NULL`

### health_checks

- `project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE`
- `enabled INTEGER NOT NULL`
- `type TEXT NOT NULL` (`http|tcp`)
- `target TEXT NOT NULL`
- `expected_status INTEGER NOT NULL DEFAULT 200`
- `interval_ms INTEGER NOT NULL`
- `timeout_ms INTEGER NOT NULL`
- `failure_threshold INTEGER NOT NULL`
- `restart_on_unhealthy INTEGER NOT NULL DEFAULT 0`
- `unhealthy_restart_cooldown_ms INTEGER NOT NULL DEFAULT 60000`

### process_instances

- `id TEXT PRIMARY KEY` (= `instanceId`)
- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
- `pid INTEGER`
- `pid_started_at TEXT` — instante de criação usado contra reuso de PID
- `started_at TEXT`
- `ended_at TEXT`
- `exit_code INTEGER`
- `exit_signal TEXT`
- `termination_reason TEXT` (`STOP_MANUAL`, `RESTART_MANUAL`, `EXIT_UNEXPECTED`, `SPAWN_FAILED`, `STOP_TIMEOUT`, `HEALTH_RESTART`, `ENGINE_SHUTDOWN`)
- `status TEXT NOT NULL CHECK` (`STOPPED|STARTING|RUNNING|STOPPING|CRASHED|RESTARTING|FAILED`)
- `created_at TEXT NOT NULL`

### system_events

- `id TEXT PRIMARY KEY`
- `project_id TEXT NULL` (sem FK: auditoria sobrevive à remoção do projeto)
- `instance_id TEXT NULL`
- `level TEXT NOT NULL CHECK` (`debug|info|warn|error`)
- `event_type TEXT NOT NULL`
- `message TEXT NOT NULL`
- `metadata_json TEXT`
- `created_at TEXT NOT NULL`

### settings

- `key TEXT PRIMARY KEY`
- `value_json TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

## 3. Índices

- `process_instances(project_id, started_at)`
- `process_instances(status)`
- `system_events(project_id, created_at)`
- `system_events(event_type, created_at)`
- `system_events(created_at)`
- `projects(group_id)`
- `projects(start_on_boot, enabled, startup_order)`

## 4. Regras

- Foreign keys ligadas (`PRAGMA foreign_keys = ON`).
- `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`.
- Escritas são exclusivas do Engine (um único escritor).
- Migrações versionadas com checksum e backup.
- Transações em toda escrita que envolve mais de uma tabela.
- Não persistir objeto Process/ChildProcess.
- Não usar SQLite como destino de stdout/stderr de alto volume.
- Histórico operacional tem retenção limitada (`deleteOlderThan`).

## 5. Backup e integridade

- Backup antes de migrações relevantes (cópia após `wal_checkpoint(TRUNCATE)`).
- Testar restauração.
- Nunca apagar banco automaticamente ao atualizar aplicativo.
- Se o banco estiver corrompido, preservar arquivo e oferecer recuperação; não
  sobrescrever silenciosamente.
