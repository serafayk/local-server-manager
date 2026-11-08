import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '@lsm/shared';

export const APP_DIRECTORY_NAME = 'LocalServerManager';

export interface AppPaths {
  /** Raiz de dados mutáveis do usuário. */
  root: string;
  dataDir: string;
  databaseFile: string;
  logsDir: string;
  backupsDir: string;
  engineDir: string;
  engineLogFile: string;
  engineInfoFile: string;
  restoreMarkerFile: string;
  engineLockKey: string;
}

export interface ResolveAppPathsOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

function defaultRoot(env: NodeJS.ProcessEnv): string {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData && localAppData.trim() !== '') {
    return join(localAppData, APP_DIRECTORY_NAME);
  }
  return join(homedir(), 'AppData', 'Local', APP_DIRECTORY_NAME);
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const env = options.env ?? process.env;
  const root = normalize(options.dataDir ?? env.LSM_DATA_DIR ?? defaultRoot(env));

  if (!isAbsolute(root)) {
    throw new AppError(
      'PROJECT_INVALID_CONFIG',
      `O diretório de dados precisa ser absoluto: ${root}`,
    );
  }

  return {
    root,
    dataDir: join(root, 'data'),
    databaseFile: join(root, 'data', 'manager.sqlite'),
    logsDir: join(root, 'logs'),
    backupsDir: join(root, 'backups'),
    engineDir: join(root, 'engine'),
    engineLogFile: join(root, 'engine', 'engine.log'),
    engineInfoFile: join(root, 'engine', 'engine.json'),
    restoreMarkerFile: join(root, 'engine', 'restore.json'),
    engineLockKey: createInstanceLockKey(root),
  };
}

/**
 * Chave de instância derivada do diretório de dados: dois Engines só
 * conflitam se forem donos do mesmo estado. Isso permite testes isolados
 * com diretórios temporários distintos no mesmo usuário.
 */
export function createInstanceLockKey(root: string): string {
  return createHash('sha1').update(normalize(root).toLowerCase()).digest('hex').slice(0, 16);
}
