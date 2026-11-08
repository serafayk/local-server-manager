import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessMetricsSample {
  pid: number;
  /** Tempo total de CPU acumulado desde o início do processo. */
  cpuSeconds: number | null;
  memoryBytes: number | null;
}

interface RawProcessMetrics {
  Id?: unknown;
  CPU?: unknown;
  WorkingSet64?: unknown;
}

/**
 * Normaliza a saída de `Get-Process | Select Id,CPU,WorkingSet64`.
 * Aceita objeto único ou array; campos ausentes viram null.
 */
export function parseProcessMetricsJson(raw: string): ProcessMetricsSample[] {
  const text = raw.trim();
  if (text === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const samples: ProcessMetricsSample[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const record = item as RawProcessMetrics;
    const pid = typeof record.Id === 'number' ? record.Id : Number(record.Id);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    samples.push({
      pid,
      cpuSeconds: typeof record.CPU === 'number' ? record.CPU : null,
      memoryBytes: typeof record.WorkingSet64 === 'number' ? record.WorkingSet64 : null,
    });
  }
  return samples;
}

/**
 * Lê CPU acumulada e memória de vários PIDs em uma única chamada.
 * Windows: PowerShell `Get-Process`; outros SOs retornam vazio (Fase 7).
 * Falha de leitura não é fatal para o chamador.
 */
export async function readProcessMetrics(
  pids: readonly number[],
): Promise<Map<number, ProcessMetricsSample>> {
  const result = new Map<number, ProcessMetricsSample>();
  const valid = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (valid.length === 0 || process.platform !== 'win32') {
    return result;
  }

  const script = [
    `Get-Process -Id ${valid.join(',')} -ErrorAction SilentlyContinue`,
    '| Select-Object Id,CPU,WorkingSet64',
    '| ConvertTo-Json -Compress',
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    for (const sample of parseProcessMetricsJson(stdout)) {
      result.set(sample.pid, sample);
    }
  } catch {
    // Métrica é melhor esforço; o coletor mantém o último valor conhecido.
  }
  return result;
}
