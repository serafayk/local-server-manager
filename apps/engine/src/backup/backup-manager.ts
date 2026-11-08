import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { AppError } from '@lsm/shared';
import type { Logger } from '@lsm/shared';

export interface BackupInfo {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupManagerOptions {
  databaseFile: string;
  backupsDir: string;
  restoreMarkerFile: string;
  logger: Logger;
  /** Executado antes da cópia para consolidar o WAL. */
  checkpoint?: () => void;
}

export interface RestoreRequestResult {
  file: string;
  restartRequired: true;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function toInfo(path: string): BackupInfo {
  const stats = statSync(path);
  return {
    file: basename(path),
    path,
    sizeBytes: stats.size,
    createdAt: stats.mtime.toISOString(),
  };
}

/**
 * Backups são cópias consistentes do SQLite (WAL consolidado antes).
 * A restauração é aplicada no próximo boot, com o banco fechado — nunca
 * trocando o arquivo embaixo de uma conexão aberta.
 */
export class BackupManager {
  private readonly options: BackupManagerOptions;

  constructor(options: BackupManagerOptions) {
    this.options = options;
    mkdirSync(options.backupsDir, { recursive: true });
  }

  create(): BackupInfo {
    this.options.checkpoint?.();
    const target = join(this.options.backupsDir, `manager-${stamp()}.sqlite`);
    copyFileSync(this.options.databaseFile, target);
    this.options.logger.info('Backup criado', { path: target });
    return toInfo(target);
  }

  list(): BackupInfo[] {
    try {
      return readdirSync(this.options.backupsDir)
        .filter((file) => /^manager-.*\.sqlite$/.test(file))
        .map((file) => join(this.options.backupsDir, file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        .map(toInfo);
    } catch {
      return [];
    }
  }

  requestRestore(file: string): RestoreRequestResult {
    const source = this.resolveBackup(file);
    if (!existsSync(source)) {
      throw new AppError('VALIDATION_ERROR', `Backup não encontrado: ${file}`);
    }
    mkdirSync(dirname(this.options.restoreMarkerFile), { recursive: true });
    writeFileSync(
      this.options.restoreMarkerFile,
      `${JSON.stringify({ source, requestedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    this.options.logger.warn('Restauração solicitada; será aplicada no próximo boot', {
      source,
    });
    return { file: basename(source), restartRequired: true };
  }

  /** Garante que o arquivo pedido está dentro de backups/ (sem traversal). */
  private resolveBackup(file: string): string {
    const base = resolve(this.options.backupsDir);
    const source = resolve(base, basename(file));
    if (!source.startsWith(base + sep)) {
      throw new AppError('VALIDATION_ERROR', 'Caminho de backup inválido');
    }
    return source;
  }
}

export interface ApplyRestoreOptions {
  databaseFile: string;
  backupsDir: string;
  restoreMarkerFile: string;
  logger: Logger;
}

/**
 * Aplica um restore pendente antes de abrir o banco. Em falha, preserva o
 * banco atual e remove o marcador para não bloquear o boot.
 */
export function applyPendingRestore(options: ApplyRestoreOptions): boolean {
  if (!existsSync(options.restoreMarkerFile)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(options.restoreMarkerFile, 'utf8')) as {
      source?: unknown;
    };
    const source = typeof parsed.source === 'string' ? resolve(parsed.source) : '';
    const base = resolve(options.backupsDir);
    if (source === '' || !source.startsWith(base + sep) || !existsSync(source)) {
      throw new Error('backup de origem inválido');
    }

    mkdirSync(options.backupsDir, { recursive: true });
    if (existsSync(options.databaseFile)) {
      copyFileSync(
        options.databaseFile,
        join(options.backupsDir, `manager-pre-restore-${stamp()}.sqlite`),
      );
    }

    // Arquivos WAL/SHM pertencem ao banco substituído; removê-los evita
    // replay de páginas antigas sobre o backup restaurado.
    for (const suffix of ['-wal', '-shm']) {
      try {
        unlinkSync(`${options.databaseFile}${suffix}`);
      } catch {
        // arquivo pode não existir
      }
    }

    copyFileSync(source, options.databaseFile);
    unlinkSync(options.restoreMarkerFile);
    options.logger.warn('Backup restaurado no boot', { source });
    return true;
  } catch (error) {
    options.logger.error(
      'Falha ao aplicar restauração pendente; mantendo o banco atual',
      {},
      error,
    );
    try {
      unlinkSync(options.restoreMarkerFile);
    } catch {
      // marcador pode já ter sido removido
    }
    return false;
  }
}
