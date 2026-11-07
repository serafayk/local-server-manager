import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface KillTreeResult {
  /** `true` quando o comando de encerramento foi aceito pelo SO. */
  accepted: boolean;
  method: 'taskkill' | 'signal';
}

export interface KillTreeOptions {
  force?: boolean;
  timeoutMs?: number;
}

/**
 * Encerra a árvore de processos de um PID que pertence ao Engine.
 *
 * Nunca chamar sem verificação de propriedade (ver `pidMatchesStartTime`).
 * `taskkill /T` usa a árvore de PPIDs do Windows; processos que já foram
 * reparentados exigem Job Objects (Fase 7) — limitação documentada.
 */
export async function killProcessTree(
  pid: number,
  options: KillTreeOptions = {},
): Promise<KillTreeResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { accepted: false, method: process.platform === 'win32' ? 'taskkill' : 'signal' };
  }
  const force = options.force ?? true;
  const timeout = options.timeoutMs ?? 15_000;

  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) {
      args.push('/F');
    }
    try {
      await execFileAsync('taskkill.exe', args, { timeout, windowsHide: true });
      return { accepted: true, method: 'taskkill' };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      const notFound = /not found|não encontrado|no running instance/i.test(err.stderr ?? '');
      return { accepted: notFound ? false : true, method: 'taskkill' };
    }
  }

  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    return { accepted: true, method: 'signal' };
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return { accepted: true, method: 'signal' };
    } catch {
      return { accepted: false, method: 'signal' };
    }
  }
}
