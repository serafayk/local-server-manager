/**
 * Relógio injetável: testes de backoff e timeout rodam sem esperar tempo real
 * e sem depender de Date global.
 */
export interface Clock {
  now(): Date;
  nowIso(): string;
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  readonly id: unknown;
  unref(): void;
}

const systemClock: Clock = {
  now: () => new Date(),
  nowIso() {
    return this.now().toISOString();
  },
  nowMs() {
    return this.now().getTime();
  },
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return {
      id: timer,
      unref() {
        timer.unref();
      },
    };
  },
  clearTimeout(handle) {
    clearTimeout(handle.id as NodeJS.Timeout);
  },
};

export function createSystemClock(): Clock {
  return systemClock;
}

/**
 * Relógio controlável para testes determinísticos.
 * Não executa timers automaticamente: o teste decide quando avançar.
 */
export class FakeClock implements Clock {
  private currentMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.currentMs = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.currentMs + Math.max(0, delayMs), callback });
    return { id, unref: () => undefined };
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id as number);
  }

  /** Avança o tempo e executa timers vencidos em ordem cronológica. */
  advanceBy(delayMs: number): void {
    const target = this.currentMs + delayMs;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      const next = due[0];
      if (!next) {
        break;
      }
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentMs = timer.at;
      timer.callback();
    }
    this.currentMs = target;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
