import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessEntry {
  pid: number;
  name: string;
  memoryBytes: number | null;
}

export interface ProcessMetricsSample {
  pid: number;
  /** Tempo total de CPU acumulado desde o início do processo (árvore somada). */
  cpuSeconds: number | null;
  /** Working set somado da árvore de processos. */
  memoryBytes: number | null;
  /** Memória privada somada (PrivatePageCount), quando disponível. */
  privateBytes?: number | null;
  /** Quantidade de processos da árvore (raiz incluída). */
  processCount?: number;
  /** Maiores processos da árvore, para detalhamento na UI. */
  processes?: ProcessEntry[];
}

export interface RawProcessRow {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  Name?: unknown;
  WorkingSetSize?: unknown;
  PrivatePageCount?: unknown;
  KernelModeTime?: unknown;
  UserModeTime?: unknown;
}

interface NormalizedProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  memoryBytes: number | null;
  privateBytes: number | null;
  cpuSeconds: number | null;
}

const MAX_DETAILED_PROCESSES = 5;
/** Processos de infraestrutura do Windows que distorcem contagem e memória. */
const IGNORED_PROCESS_NAMES = /^(conhost|werfault|openconsole|runtimebroker)\.exe$/i;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeRows(items: unknown[]): NormalizedProcessRow[] {
  const rows: NormalizedProcessRow[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const raw = item as RawProcessRow;
    const pid = toNumber(raw.ProcessId);
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const kernel = toNumber(raw.KernelModeTime) ?? 0;
    const user = toNumber(raw.UserModeTime) ?? 0;
    const name = typeof raw.Name === 'string' ? raw.Name : '';
    if (IGNORED_PROCESS_NAMES.test(name)) {
      continue;
    }
    rows.push({
      pid,
      parentPid: toNumber(raw.ParentProcessId) ?? 0,
      name,
      memoryBytes: toNumber(raw.WorkingSetSize),
      privateBytes: toNumber(raw.PrivatePageCount),
      // Win32_Process devolve tempos em unidades de 100 ns.
      cpuSeconds: kernel + user > 0 ? (kernel + user) / 10_000_000 : null,
    });
  }
  return rows;
}

/** Aceita objeto único ou array; campos ausentes viram null. */
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
    const record = item as RawProcessRow & { CPU?: unknown; Id?: unknown; WorkingSet64?: unknown };
    const pid = toNumber(record.Id ?? record.ProcessId);
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    samples.push({
      pid,
      cpuSeconds: toNumber(record.CPU),
      memoryBytes: toNumber(record.WorkingSet64 ?? record.WorkingSetSize),
    });
  }
  return samples;
}

/**
 * Soma working set, memória privada e CPU de cada árvore de processos.
 * Uma única leitura do sistema cobre todos os projetos; ciclos e PIDs
 * repetidos são ignorados para não inflar a conta.
 */
export function aggregateProcessTrees(
  raw: string | unknown[],
  rootPids: readonly number[],
): Map<number, ProcessMetricsSample> {
  let items: unknown[];
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') {
      return new Map();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Map();
    }
    items = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    items = raw;
  }

  const rows = normalizeRows(items);
  const byPid = new Map<number, NormalizedProcessRow>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const list = children.get(row.parentPid);
    if (list) {
      list.push(row.pid);
    } else {
      children.set(row.parentPid, [row.pid]);
    }
  }

  const result = new Map<number, ProcessMetricsSample>();
  const roots = [...new Set(rootPids.filter((pid) => Number.isInteger(pid) && pid > 0))];

  for (const root of roots) {
    const treePids: number[] = [];
    const visited = new Set<number>();
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      treePids.push(current);
      for (const child of children.get(current) ?? []) {
        if (!visited.has(child)) {
          queue.push(child);
        }
      }
    }

    let memoryBytes = 0;
    let privateBytes = 0;
    let cpuSeconds = 0;
    let hasMemory = false;
    let hasPrivate = false;
    let hasCpu = false;
    const detail: ProcessEntry[] = [];

    for (const pid of treePids) {
      const row = byPid.get(pid);
      if (!row) {
        continue;
      }
      if (row.memoryBytes !== null) {
        memoryBytes += row.memoryBytes;
        hasMemory = true;
        detail.push({ pid: row.pid, name: row.name, memoryBytes: row.memoryBytes });
      }
      if (row.privateBytes !== null) {
        privateBytes += row.privateBytes;
        hasPrivate = true;
      }
      if (row.cpuSeconds !== null) {
        cpuSeconds += row.cpuSeconds;
        hasCpu = true;
      }
    }

    detail.sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));

    result.set(root, {
      pid: root,
      cpuSeconds: hasCpu ? cpuSeconds : null,
      memoryBytes: hasMemory ? memoryBytes : null,
      privateBytes: hasPrivate ? privateBytes : null,
      processCount: treePids.filter((pid) => byPid.has(pid)).length,
      processes: detail.slice(0, MAX_DETAILED_PROCESSES),
    });
  }

  return result;
}

/**
 * Lê CPU acumulada e memória de vários PIDs em uma única chamada.
 * Windows: PowerShell `Get-Process`; outros SOs retornam vazio.
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

/**
 * Lê a árvore de processos de cada PID raiz em uma única consulta.
 * Inclui filhos e netos (pnpm → pnpm run → node/tsx), que é onde o consumo
 * real do servidor aparece.
 */
export async function readProcessTreeMetrics(
  rootPids: readonly number[],
): Promise<Map<number, ProcessMetricsSample>> {
  const valid = [...new Set(rootPids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (valid.length === 0 || process.platform !== 'win32') {
    return new Map();
  }

  const script = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime',
    '| ConvertTo-Json -Compress',
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return aggregateProcessTrees(stdout, valid);
  } catch {
    return new Map();
  }
}
