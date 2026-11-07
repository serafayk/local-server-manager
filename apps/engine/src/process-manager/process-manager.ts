import { setTimeout as delay } from 'node:timers/promises';
import { isProcessAlive, killProcessTree } from '@lsm/platform-win';
import type { Logger } from '@lsm/shared';
import { spawnManagedProcess, type ManagedProcess, type SpawnRequest } from './spawn-adapter';

export type StopOutcome = 'already-stopped' | 'graceful' | 'forced' | 'timeout';

export interface StopOptions {
  gracefulTimeoutMs: number;
  /** Espera adicional após o kill forçado. */
  forceTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Executa spawn e encerramento de árvore.
 *
 * Limitação conhecida do Windows (ADR-011): `SIGTERM` não existe para
 * processos de outro processo; o encerramento cooperativo é uma tentativa
 * via `taskkill /T` sem `/F`, seguida de `/F`.
 */
export class ProcessManager {
  constructor(private readonly logger: Logger) {}

  spawn(request: SpawnRequest): ManagedProcess {
    this.logger.debug('spawn', {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
    });
    return spawnManagedProcess(request);
  }

  async stop(pid: number, options: StopOptions): Promise<StopOutcome> {
    if (!isProcessAlive(pid)) {
      return 'already-stopped';
    }
    const pollIntervalMs = options.pollIntervalMs ?? 50;

    if (process.platform === 'win32') {
      await killProcessTree(pid, { force: false });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Processo pode ter encerrado entre a checagem e o sinal.
        }
      }
    }

    // No Windows, `taskkill /T` sem `/F` não é um sinal cooperativo para
    // aplicações de console: esperar o timeout inteiro só atrasa o stop.
    // ADR-011 documenta a limitação e o limite curto de confirmação.
    const gracefulWaitMs =
      process.platform === 'win32'
        ? Math.min(options.gracefulTimeoutMs, 500)
        : options.gracefulTimeoutMs;

    if (await waitForDeath(pid, gracefulWaitMs, pollIntervalMs)) {
      return 'graceful';
    }

    this.logger.warn('Encerramento gracioso não confirmado; aplicando kill forçado', { pid });
    await killProcessTree(pid, { force: true });

    if (await waitForDeath(pid, options.forceTimeoutMs ?? 5_000, pollIntervalMs)) {
      return 'forced';
    }
    return 'timeout';
  }
}

async function waitForDeath(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(pollIntervalMs);
  }
  return !isProcessAlive(pid);
}
