import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig, PostgresServiceConfig } from '@lsm/contracts';
import { detectPostgresInstallations } from '@lsm/platform-win';
import { AppError } from '@lsm/shared';

export const DEFAULT_POSTGRES_PORT = 55_432;
const CONNECT_HOST = '127.0.0.1';
const DATABASE = 'postgres';

export interface ResolvedPostgres {
  version: string | null;
  binDir: string;
  dataDir: string;
  username: string;
  password: string;
  port: number;
}

export function postgresConfigOf(config: ProjectConfig): PostgresServiceConfig {
  if (config.postgres === null) {
    throw new AppError(
      'PROJECT_INVALID_CONFIG',
      `O projeto "${config.name}" é PostgreSQL mas não tem configuração de serviço`,
    );
  }
  return config.postgres;
}

/** Resolve binDir/dataDir/porta a partir do config, com defaults do Engine. */
export function resolvePostgresConfig(
  config: ProjectConfig,
  postgresRoot: string,
): ResolvedPostgres {
  const postgres = postgresConfigOf(config);
  let binDir = postgres.binDir;
  let version = postgres.version;

  if (binDir === null) {
    const installations = detectPostgresInstallations();
    const chosen = installations[0];
    if (!chosen) {
      throw new AppError(
        'EXECUTABLE_NOT_FOUND',
        `PostgreSQL não encontrado. Instale o PostgreSQL ou informe a pasta bin em "${config.name}".`,
      );
    }
    binDir = chosen.binDir;
    version = version ?? chosen.version;
  }

  const executable = join(binDir, 'postgres.exe');
  if (!existsSync(executable)) {
    throw new AppError(
      'EXECUTABLE_NOT_FOUND',
      `postgres.exe não encontrado em ${binDir}. Ajuste a instalação do PostgreSQL em "${config.name}".`,
    );
  }

  const installed = detectPostgresInstallations().find(
    (item) => item.binDir.toLowerCase() === binDir?.toLowerCase(),
  );

  return {
    version: version ?? installed?.version ?? null,
    binDir,
    dataDir: postgres.dataDir ?? join(postgresRoot, config.id),
    username: postgres.username,
    password: postgres.password,
    port: postgres.port ?? DEFAULT_POSTGRES_PORT,
  };
}

export function postgresSpawnSpec(resolved: ResolvedPostgres): {
  executable: string;
  args: string[];
  cwd: string;
} {
  return {
    executable: join(resolved.binDir, 'postgres.exe'),
    args: ['-D', resolved.dataDir, '-p', String(resolved.port), '-c', 'listen_addresses=127.0.0.1'],
    cwd: resolved.dataDir,
  };
}

export function initdbSpec(
  resolved: ResolvedPostgres,
  passwordFile: string,
): { executable: string; args: string[]; cwd: string } {
  return {
    executable: join(resolved.binDir, 'initdb.exe'),
    args: [
      '-D',
      resolved.dataDir,
      '-U',
      resolved.username,
      '--pwfile',
      passwordFile,
      '--auth-host=scram-sha-256',
      '--auth-local=trust',
      '--encoding=UTF8',
      '--locale=C',
    ],
    cwd: resolved.binDir,
  };
}

export function pgDumpSpec(
  resolved: ResolvedPostgres,
  outputFile: string,
): { executable: string; args: string[]; env: Record<string, string> } {
  return {
    executable: join(resolved.binDir, 'pg_dump.exe'),
    args: [
      '-h',
      CONNECT_HOST,
      '-p',
      String(resolved.port),
      '-U',
      resolved.username,
      '-d',
      DATABASE,
      '-Fc',
      '-f',
      outputFile,
    ],
    env: { PGPASSWORD: resolved.password },
  };
}

export function postgresConnectionUrl(resolved: ResolvedPostgres): string {
  const password = encodeURIComponent(resolved.password);
  return `postgresql://${resolved.username}:${password}@${CONNECT_HOST}:${resolved.port}/${DATABASE}`;
}

/** `true` quando o data dir já foi inicializado (initdb é idempotente por arquivo). */
export function isInitialized(dataDir: string): boolean {
  return existsSync(join(dataDir, 'PG_VERSION'));
}

/** Consulta TCP usada para validar o servidor após o start. */
export function postgresHealthTarget(resolved: ResolvedPostgres): string {
  return `${CONNECT_HOST}:${String(resolved.port)}`;
}
