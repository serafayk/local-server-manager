import type { HealthCheckConfig, HealthStatus } from '@lsm/contracts';
import type { Clock, TimerHandle } from '@lsm/shared';
import { defaultProbe, type HealthProbeResult } from './probes';

export interface HealthMonitorOptions {
  config: HealthCheckConfig;
  clock: Clock;
  probe?: (config: HealthCheckConfig) => Promise<HealthProbeResult>;
  onChanged: (health: HealthStatus, detail: string) => void;
  onRestartRequested: (detail: string) => void;
}

/**
 * Executa probes independentes do estado do processo
 * (docs/03-ENGINE.md §7). Saúde nunca altera status por si só; apenas
 * `restartOnUnhealthy` solicita um restart controlado, com cooldown.
 */
export class HealthMonitor {
  private config: HealthCheckConfig;
  private readonly options: HealthMonitorOptions;
  private timer: TimerHandle | null = null;
  private running = false;
  private failures = 0;
  private current: HealthStatus = 'UNKNOWN';
  private lastRestartAt = Number.NEGATIVE_INFINITY;

  constructor(options: HealthMonitorOptions) {
    this.options = options;
    this.config = options.config;
  }

  get health(): HealthStatus {
    return this.current;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  start(): void {
    if (this.running || !this.config.enabled) {
      return;
    }
    this.running = true;
    this.failures = 0;
    this.current = 'UNKNOWN';
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.options.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.failures = 0;
    this.current = 'UNKNOWN';
  }

  updateConfig(config: HealthCheckConfig): void {
    this.config = config;
    if (this.running && !config.enabled) {
      this.stop();
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    const probe = this.options.probe ?? defaultProbe;

    let result: HealthProbeResult;
    try {
      result = await probe(this.config);
    } catch (error) {
      result = {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!this.running) {
      return;
    }

    if (result.ok) {
      this.failures = 0;
      this.setHealth('HEALTHY', result.detail);
    } else {
      this.failures += 1;
      if (this.failures >= this.config.failureThreshold) {
        this.setHealth('UNHEALTHY', result.detail);
        this.maybeRequestRestart(result.detail);
      }
    }

    this.schedule();
  }

  private schedule(): void {
    if (!this.running) {
      return;
    }
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.config.intervalMs);
    this.timer.unref();
  }

  private setHealth(next: HealthStatus, detail: string): void {
    if (this.current === next) {
      return;
    }
    this.current = next;
    this.options.onChanged(next, detail);
  }

  private maybeRequestRestart(detail: string): void {
    if (!this.config.restartOnUnhealthy) {
      return;
    }
    const now = this.options.clock.nowMs();
    if (now - this.lastRestartAt < this.config.unhealthyRestartCooldownMs) {
      return;
    }
    this.lastRestartAt = now;
    this.options.onRestartRequested(detail);
  }
}
