import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@lsm/shared';
import { detectPackageManager, type DetectedPackageManager } from './package-manager';

export interface DetectedScript {
  name: string;
  command: string;
}

export interface ProjectInspection {
  directory: string;
  hasPackageJson: boolean;
  projectName: string | null;
  scripts: DetectedScript[];
  packageManager: DetectedPackageManager;
}

/**
 * Inspeção read-only de uma pasta de projeto (RF-002/RF-012).
 * Nunca executa script nem instala dependências durante a detecção.
 */
export function inspectProjectDirectory(directory: string): ProjectInspection {
  let isDirectory = false;
  try {
    isDirectory = statSync(directory).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new AppError('WORKING_DIRECTORY_NOT_FOUND', `Diretório não encontrado: ${directory}`, {
      directory,
    });
  }

  const packageManager = detectPackageManager(directory);
  const packageJsonPath = join(directory, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return {
      directory,
      hasPackageJson: false,
      projectName: null,
      scripts: [],
      packageManager,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new AppError(
      'PROJECT_INVALID_CONFIG',
      `package.json inválido em ${directory}`,
      undefined,
      { cause: error },
    );
  }

  const record = (parsed ?? {}) as { name?: unknown; scripts?: unknown };
  const projectName = typeof record.name === 'string' ? record.name : null;

  const scripts: DetectedScript[] = [];
  if (record.scripts !== null && typeof record.scripts === 'object') {
    for (const [name, command] of Object.entries(record.scripts as Record<string, unknown>)) {
      if (typeof command === 'string') {
        scripts.push({ name, command });
      }
    }
  }
  scripts.sort((a, b) => a.name.localeCompare(b.name));

  return {
    directory,
    hasPackageJson: true,
    projectName,
    scripts,
    packageManager,
  };
}
