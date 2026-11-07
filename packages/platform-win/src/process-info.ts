import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Existência de processo sem depender de bibliotecas nativas.
 * `EPERM` significa que o processo existe mas não temos permissão — ainda é
 * um processo vivo, portanto tratamos como vivo.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Instante de criação do processo. É a defesa contra reuso de PID no Windows
 * (ADR-010): um PID só é considerado nosso se o StartTime bater.
 * Retorna `null` quando o processo não existe ou a consulta não é possível.
 */
export async function getProcessStartTimeIso(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 5_000,
      });
      const text = stdout.trim();
      if (!text) {
        return null;
      }
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    } catch {
      return null;
    }
  }

  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
    `if ($p) { $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }`,
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5_000, windowsHide: true },
    );
    const text = stdout.trim();
    if (!text) {
      return null;
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  } catch {
    return null;
  }
}

/**
 * Confirma que o PID ainda pertence à instância que o Engine iniciou.
 * Tolerância cobre diferenças de arredondamento entre o relógio do Node e o
 * do Windows, sem mascarar reuso de PID (que ocorre em escala de segundos).
 */
export async function pidMatchesStartTime(
  pid: number,
  expectedStartIso: string,
  toleranceMs = 2_000,
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const actual = await getProcessStartTimeIso(pid);
  if (actual === null) {
    return false;
  }
  const expected = Date.parse(expectedStartIso);
  const actualMs = Date.parse(actual);
  if (Number.isNaN(expected) || Number.isNaN(actualMs)) {
    return false;
  }
  return Math.abs(actualMs - expected) <= toleranceMs;
}
