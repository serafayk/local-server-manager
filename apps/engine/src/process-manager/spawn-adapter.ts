import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached?: boolean;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Wrapper fino sobre ChildProcess com as opções obrigatórias de segurança:
 * sem shell, janela oculta e stdio isolado (docs/03-ENGINE.md §5).
 */
export class ManagedProcess {
  readonly child: ChildProcess;
  readonly pid: number;

  constructor(child: ChildProcess) {
    this.child = child;
    this.pid = child.pid ?? -1;
  }

  onSpawn(handler: () => void): void {
    this.child.once('spawn', handler);
  }

  onError(handler: (error: Error) => void): void {
    this.child.on('error', handler);
  }

  onExit(handler: (info: ExitInfo) => void): void {
    this.child.on('exit', (code, signal) => handler({ code, signal }));
  }

  onStdout(handler: (chunk: Buffer) => void): void {
    this.child.stdout?.on('data', handler);
  }

  onStderr(handler: (chunk: Buffer) => void): void {
    this.child.stderr?.on('data', handler);
  }
}

export function spawnManagedProcess(request: SpawnRequest): ManagedProcess {
  const child = spawn(request.executable, request.args, {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Em POSIX, um novo grupo de processos permite encerrar a árvore via -pid.
    detached: request.detached ?? process.platform !== 'win32',
  });
  return new ManagedProcess(child);
}
