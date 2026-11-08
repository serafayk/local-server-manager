import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Logger } from '@lsm/shared';

export const HOSTS_FILE_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
export const MANAGED_BEGIN = '# >>> Local Server Manager >>>';
export const MANAGED_END = '# <<< Local Server Manager <<<';

/** Hosts gerenciados pelo LSM, na ordem em que aparecem no arquivo. */
export function extractManagedHosts(content: string): string[] {
  const hosts: string[] = [];
  let inside = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === MANAGED_BEGIN) {
      inside = true;
      continue;
    }
    if (trimmed === MANAGED_END) {
      inside = false;
      continue;
    }
    if (!inside || trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const host = parts[1]?.toLowerCase();
    if (host) {
      hosts.push(host);
    }
  }
  return hosts;
}

function withoutManagedBlock(content: string): string[] {
  const lines = content.split(/\r?\n/).map((line) => line.replace(/\r$/, ''));
  const result: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === MANAGED_BEGIN) {
      inside = true;
      continue;
    }
    if (trimmed === MANAGED_END) {
      inside = false;
      continue;
    }
    if (!inside) {
      result.push(line);
    }
  }
  while (result.length > 0 && (result[result.length - 1] ?? '').trim() === '') {
    result.pop();
  }
  return result;
}

/**
 * Reinsere o bloco gerenciado no fim do arquivo, preservando todo o resto.
 * Idempotente: o mesmo conjunto de hosts gera exatamente o mesmo conteúdo.
 */
export function renderHostsWithBlock(content: string, hosts: readonly string[]): string {
  const clean = withoutManagedBlock(content);
  const unique = [...new Set(hosts.map((host) => host.toLowerCase()))].sort();
  const lines = [...clean];
  if (unique.length > 0) {
    lines.push('', MANAGED_BEGIN, ...unique.map((host) => `127.0.0.1 ${host}`), MANAGED_END);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Hosts desejados que ainda não estão no bloco gerenciado. */
export function pendingHosts(content: string, desired: readonly string[]): string[] {
  const present = new Set(extractManagedHosts(content));
  return [...new Set(desired.map((host) => host.toLowerCase()))]
    .filter((host) => !present.has(host))
    .sort();
}

export interface ElevatedResult {
  code: number;
  stderr: string;
}

export type ElevatedRunner = (content: string) => Promise<ElevatedResult>;

export interface HostsManagerOptions {
  logger: Logger;
  filePath?: string;
  runElevated?: ElevatedRunner;
}

export interface HostsSyncOutcome {
  ok: boolean;
  applied: string[];
  pending: string[];
  error: string | null;
}

/**
 * Arquivo hosts do Windows. A escrita exige administrador, então o conteúdo é
 * preparado pelo Engine e copiado por um processo elevado (UAC) em lote.
 */
export class HostsManager {
  private readonly filePath: string;
  private readonly runElevated: ElevatedRunner;

  constructor(private readonly options: HostsManagerOptions) {
    this.filePath = options.filePath ?? HOSTS_FILE_PATH;
    this.runElevated = options.runElevated ?? ((content) => copyElevated(content, this.filePath));
  }

  get path(): string {
    return this.filePath;
  }

  read(): string {
    try {
      return readFileSync(this.filePath, 'utf8');
    } catch (error) {
      this.options.logger.warn('Falha ao ler o arquivo hosts', {}, error);
      return '';
    }
  }

  managedHosts(): string[] {
    return extractManagedHosts(this.read());
  }

  pending(desired: readonly string[]): string[] {
    return pendingHosts(this.read(), desired);
  }

  async sync(desired: readonly string[]): Promise<HostsSyncOutcome> {
    const current = this.read();
    const desiredSorted = [...new Set(desired.map((host) => host.toLowerCase()))].sort();
    const currentManaged = extractManagedHosts(current).sort();
    if (
      currentManaged.length === desiredSorted.length &&
      currentManaged.every((host, index) => host === desiredSorted[index])
    ) {
      return { ok: true, applied: [], pending: [], error: null };
    }

    try {
      const result = await this.runElevated(renderHostsWithBlock(current, desired));
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        return {
          ok: false,
          applied: [],
          pending: this.pending(desired),
          error: detail === '' ? 'Operação cancelada ou sem permissão (UAC).' : detail,
        };
      }
    } catch (error) {
      return {
        ok: false,
        applied: [],
        pending: this.pending(desired),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.flushDns();
    const pending = this.pending(desired);
    return {
      ok: pending.length === 0,
      applied: pending.length === 0 ? desiredSorted : [],
      pending,
      error: pending.length === 0 ? null : 'O arquivo hosts não refletiu a alteração.',
    };
  }

  private flushDns(): void {
    try {
      const child = spawn('ipconfig.exe', ['/flushdns'], { windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // flushdns é best-effort
    }
  }
}

/**
 * Copia o conteúdo para o hosts via PowerShell elevado. A escrita em si é
 * feita por `Copy-Item` de um arquivo temporário, evitando problemas de
 * escaping no conteúdo.
 */
function copyElevated(content: string, filePath: string): Promise<ElevatedResult> {
  const tempFile = join(tmpdir(), `lsm-hosts-${process.pid}-${Date.now().toString(36)}.txt`);
  writeFileSync(tempFile, content, 'utf8');

  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `Copy-Item -LiteralPath '${tempFile.replace(/'/g, "''")}' -Destination '${filePath.replace(/'/g, "''")}' -Force`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  const command = [
    `$p = Start-Process -FilePath 'powershell.exe'`,
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    `-Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
  ].join(' ');

  return new Promise<ElevatedResult>((resolvePromise) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: 1, stderr: 'Tempo esgotado aguardando a confirmação do UAC.' });
    }, 120_000);
    timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stderr });
    });
  });
}
