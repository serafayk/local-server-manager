import type { ProjectRuntime } from './project-runtime';

/** Uma instância de runtime por projeto, indexada por id. */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();

  add(runtime: ProjectRuntime): void {
    this.runtimes.set(runtime.projectId, runtime);
  }

  get(projectId: string): ProjectRuntime | undefined {
    return this.runtimes.get(projectId);
  }

  has(projectId: string): boolean {
    return this.runtimes.has(projectId);
  }

  remove(projectId: string): boolean {
    return this.runtimes.delete(projectId);
  }

  list(): ProjectRuntime[] {
    return [...this.runtimes.values()];
  }

  get size(): number {
    return this.runtimes.size;
  }

  clear(): void {
    this.runtimes.clear();
  }
}
