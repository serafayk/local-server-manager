import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helpersDir = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = join(helpersDir, '..', 'fixtures');

export function createTempDir(prefix = 'lsm-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout aguardando: ${options.description ?? 'condição'}`);
}

export * from './project';
