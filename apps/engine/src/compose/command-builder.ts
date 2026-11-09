import { isAbsolute, join } from 'node:path';
import type { ProjectConfig } from '@lsm/contracts';
import { AppError } from '@lsm/shared';

export interface ComposeSpec {
  executable: string;
  cwd: string;
  file: string;
  projectName: string | null;
}

export function composeConfigOf(config: ProjectConfig): ComposeSpec {
  if (config.compose === null) {
    throw new AppError(
      'PROJECT_INVALID_CONFIG',
      `O projeto "${config.name}" é Docker Compose mas não tem arquivo configurado`,
    );
  }
  const cwd = config.workingDirectory;
  return {
    executable: config.compose.dockerExecutable ?? 'docker',
    cwd,
    file: isAbsolute(config.compose.file) ? config.compose.file : join(cwd, config.compose.file),
    projectName: config.compose.projectName,
  };
}

function prefix(spec: ComposeSpec): string[] {
  const args = ['compose', '-f', spec.file];
  if (spec.projectName !== null) {
    args.push('-p', spec.projectName);
  }
  return args;
}

/**
 * `up` anexado: o processo do Docker CLI fica vivo enquanto os containers
 * rodam, então o supervisor enxerga crash/saída como qualquer projeto.
 */
export function composeUpSpec(config: ProjectConfig): {
  executable: string;
  args: string[];
  cwd: string;
} {
  const spec = composeConfigOf(config);
  return {
    executable: spec.executable,
    args: [...prefix(spec), 'up', '--abort-on-container-exit', '--remove-orphans'],
    cwd: spec.cwd,
  };
}

/** Limpeza garantida ao parar: o taskkill no CLI pode não derrubar containers. */
export function composeDownArgs(config: ProjectConfig): {
  executable: string;
  args: string[];
  cwd: string;
} {
  const spec = composeConfigOf(config);
  return {
    executable: spec.executable,
    args: [...prefix(spec), 'down', '--remove-orphans'],
    cwd: spec.cwd,
  };
}
