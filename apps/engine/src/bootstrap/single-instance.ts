import { openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive } from '@lsm/platform-win';
import { AppError } from '@lsm/shared';

export interface InstanceLock {
  /** Identificador do recurso de lock (pipe ou arquivo). */
  readonly resource: string;
  release(): Promise<void>;
}

function pipePath(key: string): string {
  return `\\\\.\\pipe\\local-server-manager-${key}`;
}

function lockFilePath(key: string): string {
  return join(tmpdir(), `local-server-manager-${key}.lock`);
}

/**
 * Garante uma única instância do Engine por diretório de dados.
 *
 * Windows: named pipe (o bind falha com EADDRINUSE se já existir).
 * POSIX: arquivo de lock com PID + verificação de processo vivo.
 */
export async function acquireInstanceLock(key: string): Promise<InstanceLock> {
  if (process.platform === 'win32') {
    return acquirePipeLock(key);
  }
  return acquireFileLock(key);
}

function acquirePipeLock(key: string): Promise<InstanceLock> {
  const resource = pipePath(key);
  return new Promise<InstanceLock>((resolve, reject) => {
    const server: Server = createServer((socket) => {
      socket.end('ENGINE_ALREADY_RUNNING');
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new AppError(
            'ENGINE_BUSY',
            'Já existe um Engine em execução para este diretório de dados.',
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(resource, () => {
      resolve({
        resource,
        release: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function acquireFileLock(key: string): InstanceLock {
  const resource = lockFilePath(key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(resource, 'wx');
      writeFileSync(fd, String(process.pid), 'utf8');
      closeSync(fd);
      return {
        resource,
        release: async () => {
          try {
            unlinkSync(resource);
          } catch {
            // Lock já removido.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
      let ownerPid = 0;
      try {
        ownerPid = Number.parseInt(readFileSync(resource, 'utf8').trim(), 10);
      } catch {
        ownerPid = 0;
      }
      if (ownerPid > 0 && isProcessAlive(ownerPid)) {
        throw new AppError(
          'ENGINE_BUSY',
          `Já existe um Engine em execução (pid ${ownerPid}) para este diretório de dados.`,
        );
      }
      try {
        unlinkSync(resource);
      } catch {
        // Corrida com outro processo: a próxima tentativa decide.
      }
    }
  }
  throw new AppError('ENGINE_BUSY', 'Não foi possível adquirir o lock de instância única.');
}
