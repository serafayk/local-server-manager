import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortCheckResult {
  port: number;
  inUse: boolean;
  ownerPid: number | null;
}

/**
 * Testa disponibilidade fazendo bind exclusivo em loopback. O socket é
 * fechado imediatamente; nada é morto ou alterado.
 */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(free);
    };
    server.once('error', () => finish(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => finish(true));
    });
  });
}

/** Extrai o PID dono de uma porta listada em `netstat -ano -p tcp`. */
export function parseNetstatOwner(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('TCP') || !trimmed.includes('LISTENING')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const localAddress = parts[1] ?? '';
    const match = /:(\d+)$/.exec(localAddress);
    if (!match || Number(match[1]) !== port) {
      continue;
    }
    const pid = Number(parts[4]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

export async function getPortOwnerPid(port: number): Promise<number | null> {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseNetstatOwner(stdout, port);
  } catch {
    return null;
  }
}

export async function checkPort(port: number, host = '127.0.0.1'): Promise<PortCheckResult> {
  const free = await isPortFree(port, host);
  if (free) {
    return { port, inUse: false, ownerPid: null };
  }
  return { port, inUse: true, ownerPid: await getPortOwnerPid(port) };
}
