import { readdirSync, rmdirSync, statSync, unlinkSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOGGING } from '@lsm/config';
import type { Logger } from '@lsm/shared';

export interface LogRetentionOptions {
  logsDir: string;
  /** projectId -> dias de retenção configurados no projeto. */
  retentionByProject: ReadonlyMap<string, number>;
  /** Instâncias com arquivo aberto no momento da limpeza. */
  activeInstanceIds: ReadonlySet<string>;
  /** Injetável para teste. */
  nowMs?: number;
  logger?: Logger;
}

export interface LogRetentionResult {
  removedFiles: number;
  removedBytes: number;
  removedDirectories: number;
  skippedActive: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const LOG_FILE_PATTERN = /^(.+)\.log(\.\d+)?$/;

function instanceIdOf(fileName: string): string | null {
  const match = LOG_FILE_PATTERN.exec(fileName);
  return match?.[1] ?? null;
}

/**
 * Remove arquivos de log além da retenção por projeto
 * (docs/10-LOGGING-MONITORING.md §4). Nunca toca em arquivo de instância
 * ativa. Falha em um arquivo não interrompe a limpeza dos demais.
 */
export function runLogRetention(options: LogRetentionOptions): LogRetentionResult {
  const result: LogRetentionResult = {
    removedFiles: 0,
    removedBytes: 0,
    removedDirectories: 0,
    skippedActive: 0,
  };
  const nowMs = options.nowMs ?? Date.now();

  let projectDirectories: Dirent[];
  try {
    projectDirectories = readdirSync(options.logsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of projectDirectories) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectId = entry.name;
    const retentionDays =
      options.retentionByProject.get(projectId) ?? DEFAULT_LOGGING.retentionDays;
    if (retentionDays <= 0) {
      continue;
    }
    const cutoff = nowMs - retentionDays * DAY_MS;
    const directory = join(options.logsDir, projectId);

    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (error) {
      options.logger?.warn('Falha ao listar diretório de logs', { projectId }, error);
      continue;
    }

    for (const file of files) {
      const instanceId = instanceIdOf(file);
      if (instanceId === null) {
        continue;
      }
      if (options.activeInstanceIds.has(instanceId)) {
        result.skippedActive += 1;
        continue;
      }
      const filePath = join(directory, file);
      try {
        const stats = statSync(filePath);
        if (stats.mtimeMs >= cutoff) {
          continue;
        }
        unlinkSync(filePath);
        result.removedFiles += 1;
        result.removedBytes += stats.size;
      } catch (error) {
        options.logger?.warn('Falha ao remover log expirado', { projectId, file }, error);
      }
    }

    try {
      if (readdirSync(directory).length === 0) {
        rmdirSync(directory);
        result.removedDirectories += 1;
      }
    } catch {
      // Diretório pode ter sido removido/ocupado concorrentemente.
    }
  }

  return result;
}
