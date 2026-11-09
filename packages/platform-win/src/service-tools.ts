import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PostgresInstallationInfo {
  version: string;
  binDir: string;
  dataDir: string | null;
  service: string | null;
}

const DEFAULT_ROOTS = ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL'];

function versionScore(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return major * 1_000_000 + minor * 1_000 + patch;
}

/**
 * Instalações do PostgreSQL no Windows (instalador oficial/EDB). Não depende
 * de serviço rodando: apenas encontra `bin\postgres.exe`.
 */
export function detectPostgresInstallations(
  roots: readonly string[] = DEFAULT_ROOTS,
): PostgresInstallationInfo[] {
  const found: PostgresInstallationInfo[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const name of entries) {
      const binDir = join(root, name, 'bin');
      const executable = join(binDir, 'postgres.exe');
      if (!existsSync(executable) || seen.has(binDir.toLowerCase())) {
        continue;
      }
      seen.add(binDir.toLowerCase());
      const dataDir = join(root, name, 'data');
      found.push({
        version: name,
        binDir,
        dataDir: existsSync(dataDir) ? dataDir : null,
        service: `postgresql-x64-${name}`,
      });
    }
  }

  return found.sort((a, b) => versionScore(b.version) - versionScore(a.version));
}

export interface DockerInfo {
  available: boolean;
  version: string | null;
  composeVersion: string | null;
  error: string | null;
}

function runVersion(executable: string, args: string[]): { ok: boolean; output: string } {
  try {
    const result = spawnSync(executable, args, {
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
    });
    if (result.error) {
      return { ok: false, output: result.error.message };
    }
    return {
      ok: result.status === 0,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Detecta Docker CLI e o plugin Compose (o daemon pode estar desligado). */
export function detectDocker(executable = 'docker'): DockerInfo {
  const version = runVersion(executable, ['--version']);
  if (!version.ok) {
    return {
      available: false,
      version: null,
      composeVersion: null,
      error: version.output === '' ? 'docker não encontrado no PATH' : version.output,
    };
  }

  const compose = runVersion(executable, ['compose', 'version']);
  return {
    available: true,
    version: version.output.replace(/^docker version\s*/i, '').trim() || version.output,
    composeVersion: compose.ok ? compose.output : null,
    error: compose.ok ? null : 'plugin docker compose não encontrado',
  };
}
