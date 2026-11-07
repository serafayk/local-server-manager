/**
 * Serializa operações por projeto. Start/stop/restart concorrentes do mesmo
 * projeto não podem intercalar (docs/02-ARCHITECTURE.md §7).
 */
export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const start = this.tail.then(async () => {
      try {
        return await task();
      } finally {
        this.queued -= 1;
      }
    });
    this.tail = start.catch(() => undefined);
    return start;
  }

  get pending(): number {
    return this.queued;
  }

  async whenIdle(): Promise<void> {
    await this.tail.catch(() => undefined);
  }
}
