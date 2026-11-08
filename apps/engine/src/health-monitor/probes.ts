import { connect } from 'node:net';
import type { HealthCheckConfig } from '@lsm/contracts';

export interface HealthProbeResult {
  ok: boolean;
  detail: string;
  statusCode?: number;
}

export async function probeHttp(
  target: string,
  expectedStatus: number,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Não interessa o corpo; cancelar libera a conexão.
    await response.body?.cancel().catch(() => undefined);

    if (response.status === expectedStatus) {
      return { ok: true, statusCode: response.status, detail: `HTTP ${response.status}` };
    }
    return {
      ok: false,
      statusCode: response.status,
      detail: `HTTP ${response.status} (esperado ${expectedStatus})`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeTcp(target: string, timeoutMs: number): Promise<HealthProbeResult> {
  const separator = target.lastIndexOf(':');
  const host = separator > 0 ? target.slice(0, separator) : '';
  const port = separator > 0 ? Number(target.slice(separator + 1)) : Number.NaN;

  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, detail: `alvo TCP inválido: ${target}` };
  }

  return new Promise<HealthProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: HealthProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = connect({ host, port });
    socket.setTimeout(Math.max(100, timeoutMs));
    socket.once('connect', () => finish({ ok: true, detail: `TCP ${host}:${port}` }));
    socket.once('timeout', () => finish({ ok: false, detail: `timeout ${timeoutMs}ms` }));
    socket.once('error', (error) => finish({ ok: false, detail: error.message }));
  });
}

export async function defaultProbe(config: HealthCheckConfig): Promise<HealthProbeResult> {
  if (config.type === 'tcp') {
    return probeTcp(config.target, config.timeoutMs);
  }
  return probeHttp(config.target, config.expectedStatus, config.timeoutMs);
}
