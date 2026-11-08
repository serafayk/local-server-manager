import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeInstallation } from '@lsm/contracts';

export interface DetectNodeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Executável do próprio Engine, sempre listado. */
  engineExecutable?: string;
  engineVersion?: string;
}

/**
 * Lista instalações de Node no Windows:
 * - pastas `vX.Y.Z` do NVM for Windows (`NVM_HOME` ou `%APPDATA%\nvm`);
 * - instalação do sistema (`%ProgramFiles%\nodejs\node.exe`);
 * - o Node do próprio Engine.
 * A versão do NVM vem do nome da pasta; as demais são rótulos best-effort.
 */
export function detectNodeInstallations(options: DetectNodeOptions = {}): NodeInstallation[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return [];
  }

  const results: NodeInstallation[] = [];
  const seen = new Set<string>();

  const add = (executable: string, version: string, source: NodeInstallation['source']): void => {
    const key = executable.toLowerCase();
    if (seen.has(key) || !existsSync(executable)) {
      return;
    }
    seen.add(key);
    results.push({ version, executable, source });
  };

  const nvmHome = env.NVM_HOME ?? (env.APPDATA ? join(env.APPDATA, 'nvm') : '');
  if (nvmHome !== '') {
    try {
      for (const entry of readdirSync(nvmHome, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^v\d/.test(entry.name)) {
          continue;
        }
        add(join(nvmHome, entry.name, 'node.exe'), entry.name.replace(/^v/, ''), 'nvm');
      }
    } catch {
      // NVM não instalado.
    }
  }

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  add(join(programFiles, 'nodejs', 'node.exe'), 'sistema', 'system');

  const engineExecutable = options.engineExecutable ?? process.execPath;
  add(engineExecutable, (options.engineVersion ?? process.version).replace(/^v/, ''), 'engine');

  return results.sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' }),
  );
}
