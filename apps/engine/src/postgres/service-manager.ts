import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@lsm/shared';
import type { ResolvedPostgres } from './command-builder';

/** SID bem conhecido de NT AUTHORITY\NETWORK SERVICE (independe do idioma). */
const NETWORK_SERVICE_SID = '*S-1-5-20';
const MARKER_FILE = '.lsm-service.json';

export type ServiceState =
  'RUNNING' | 'STOPPED' | 'START_PENDING' | 'STOP_PENDING' | 'NOT_FOUND' | 'UNKNOWN';

const SC_STATES: Record<number, ServiceState> = {
  1: 'STOPPED',
  2: 'START_PENDING',
  3: 'STOP_PENDING',
  4: 'RUNNING',
};

export function postgresServiceName(projectId: string): string {
  return `lsm-pg-${projectId.replace(/-/g, '').slice(0, 10)}`;
}

function pgOptions(resolved: ResolvedPostgres): string {
  return [
    '-p',
    String(resolved.port),
    '-c',
    'listen_addresses=127.0.0.1',
    '-c',
    'logging_collector=on',
    '-c',
    'log_directory=log',
    '-c',
    'log_filename=postgresql.log',
  ].join(' ');
}

function run(
  executable: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: 124, stdout, stderr: 'Tempo esgotado' });
    }, timeoutMs);
    timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function queryPostgresService(name: string): Promise<ServiceState> {
  const result = await run('sc.exe', ['query', name], 15_000);
  if (result.code !== 0) {
    return 'NOT_FOUND';
  }
  return parseServiceState(`${result.stdout}${result.stderr}`);
}

/** `sc query` é localizado; o estado numérico é estável. */
export function parseServiceState(output: string): ServiceState {
  const match = /\b(?:STATE|ESTADO)\s*:\s*(\d+)/i.exec(output);
  if (!match?.[1]) {
    return 'UNKNOWN';
  }
  return SC_STATES[Number(match[1])] ?? 'UNKNOWN';
}

interface ServiceMarker {
  name: string;
  port: number;
  dataDir: string;
}

function readMarker(dataDir: string): ServiceMarker | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, MARKER_FILE), 'utf8')) as ServiceMarker;
  } catch {
    return null;
  }
}

/**
 * Registra a instância dedicada como serviço do Windows (conta NetworkService).
 *
 * É a única forma de rodar PostgreSQL numa máquina com UAC desabilitado, onde
 * todo processo herda o token de administrador e o `postgres.exe` se recusa.
 */
export async function ensurePostgresService(
  resolved: ResolvedPostgres,
  name: string,
): Promise<void> {
  const state = await queryPostgresService(name);
  const marker = readMarker(resolved.dataDir);
  const matches =
    marker !== null &&
    marker.name === name &&
    marker.port === resolved.port &&
    marker.dataDir.toLowerCase() === resolved.dataDir.toLowerCase();

  if (state !== 'NOT_FOUND' && matches) {
    return;
  }
  if (state !== 'NOT_FOUND') {
    // Configuração mudou (porta/data dir) ou serviço ficou inconsistente.
    await run('sc.exe', ['stop', name], 60_000);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await queryPostgresService(name)) === 'STOPPED') {
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    await run('sc.exe', ['delete', name], 30_000);
  }

  const acl = await run(
    'icacls.exe',
    [resolved.dataDir, '/grant', `${NETWORK_SERVICE_SID}:(OI)(CI)F`],
    60_000,
  );
  if (acl.code !== 0) {
    throw new AppError(
      'PROJECT_START_FAILED',
      `Não foi possível liberar o data dir para o serviço: ${acl.stderr.trim() || acl.stdout.trim()}`,
    );
  }

  const registered = await run(
    join(resolved.binDir, 'pg_ctl.exe'),
    [
      'register',
      '-N',
      name,
      '-D',
      resolved.dataDir,
      '-o',
      pgOptions(resolved),
      '-S',
      'auto',
      '-U',
      'NT AUTHORITY\\NetworkService',
    ],
    120_000,
  );
  if (registered.code !== 0) {
    const detail = `${registered.stderr}${registered.stdout}`.trim();
    throw new AppError(
      'PROJECT_START_FAILED',
      /acesso negado|access is denied|5/i.test(detail)
        ? 'Criar o serviço do PostgreSQL exige administrador. Abra o Local Server Manager como administrador.'
        : `Não foi possível registrar o serviço do PostgreSQL: ${detail || 'pg_ctl falhou'}`,
    );
  }

  writeFileSync(
    join(resolved.dataDir, MARKER_FILE),
    JSON.stringify({ name, port: resolved.port, dataDir: resolved.dataDir }, null, 2),
    'utf8',
  );
}

export async function startPostgresService(name: string): Promise<void> {
  const current = await queryPostgresService(name);
  if (current === 'RUNNING') {
    return;
  }
  if (current === 'NOT_FOUND') {
    throw new AppError('PROJECT_START_FAILED', `Serviço ${name} não registrado`);
  }
  const result = await run('sc.exe', ['start', name], 60_000);
  // 1056 = já em execução; tratamos como sucesso.
  if (result.code !== 0 && result.code !== 1056) {
    throw new AppError(
      'PROJECT_START_FAILED',
      `Falha ao iniciar o serviço ${name}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await queryPostgresService(name);
    if (state === 'RUNNING') {
      return;
    }
    if (state === 'STOPPED') {
      throw new AppError(
        'PROJECT_START_FAILED',
        `O serviço ${name} encerrou durante a inicialização. Veja os logs em data/log/postgresql.log.`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new AppError('PROJECT_START_FAILED', `O serviço ${name} não ficou RUNNING a tempo`);
}

export async function stopPostgresService(name: string): Promise<void> {
  const current = await queryPostgresService(name);
  if (current === 'NOT_FOUND' || current === 'STOPPED') {
    return;
  }
  await run('sc.exe', ['stop', name], 60_000);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await queryPostgresService(name);
    if (state === 'STOPPED' || state === 'NOT_FOUND') {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new AppError('PROJECT_STOP_TIMEOUT', `O serviço ${name} não parou a tempo`);
}

export function postgresLogFile(resolved: ResolvedPostgres): string {
  return join(resolved.dataDir, 'log', 'postgresql.log');
}

export function postgresServiceExists(dataDir: string): boolean {
  return existsSync(join(dataDir, MARKER_FILE));
}

/** Remove o serviço ao excluir o projeto (o data dir permanece no disco). */
export async function removePostgresService(name: string): Promise<void> {
  const state = await queryPostgresService(name);
  if (state === 'NOT_FOUND') {
    return;
  }
  if (state !== 'STOPPED') {
    await stopPostgresService(name).catch(() => undefined);
  }
  await run('sc.exe', ['delete', name], 30_000);
}
