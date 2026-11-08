import { cpus } from 'node:os';
import type { ProjectMetricsPayload, SystemMetricsPayload } from '@lsm/contracts';
import type { Clock, Logger } from '@lsm/shared';
import { readProcessMetrics, type ProcessMetricsSample } from '@lsm/platform-win';
import type { EventBus } from '../core/event-bus';

export interface MetricsTarget {
  projectId: string;
  pid: number;
  startedAt: string | null;
}

export interface MetricsStats {
  managed: number;
  running: number;
  crashed: number;
}

export interface MetricsSnapshot {
  projects: ProjectMetricsPayload[];
  system: SystemMetricsPayload;
  collectedAt: string;
}

export interface MetricsCollectorOptions {
  clock: Clock;
  logger: Logger;
  events: EventBus;
  intervalMs: number;
  targets: () => { targets: MetricsTarget[]; stats: MetricsStats };
  readMetrics?: (pids: readonly number[]) => Promise<Map<number, ProcessMetricsSample>>;
  cpuCount?: number;
}

export function computeCpuPercent(
  previousCpuSeconds: number,
  previousAtMs: number,
  currentCpuSeconds: number,
  nowMs: number,
  cpuCount: number,
): number | null {
  const deltaSeconds = (nowMs - previousAtMs) / 1_000;
  const deltaCpu = currentCpuSeconds - previousCpuSeconds;
  if (deltaSeconds <= 0 || deltaCpu < 0) {
    return null;
  }
  const percent = (deltaCpu / deltaSeconds / Math.max(1, cpuCount)) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

/**
 * Amostra CPU/memória em intervalo moderado. A primeira amostra de CPU é
 * `null` (só há delta a partir da segunda). Falha de leitura não derruba o
 * Engine nem zera o último valor conhecido.
 */
export class MetricsCollector {
  private readonly options: MetricsCollectorOptions;
  private readonly readMetrics: (
    pids: readonly number[],
  ) => Promise<Map<number, ProcessMetricsSample>>;
  private readonly cpuCount: number;
  private intervalMs: number;
  private timer: ReturnType<Clock['setTimeout']> | null = null;
  private collecting = false;
  private running = false;
  private snapshot: MetricsSnapshot | null = null;
  private readonly previous = new Map<number, { cpuSeconds: number; atMs: number }>();

  constructor(options: MetricsCollectorOptions) {
    this.options = options;
    this.readMetrics = options.readMetrics ?? readProcessMetrics;
    this.cpuCount = options.cpuCount ?? cpus().length ?? 1;
    this.intervalMs = options.intervalMs;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.options.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setIntervalMs(intervalMs: number): void {
    this.intervalMs = Math.max(1_000, intervalMs);
    if (this.running) {
      if (this.timer) {
        this.options.clock.clearTimeout(this.timer);
        this.timer = null;
      }
      this.schedule();
    }
  }

  latest(): MetricsSnapshot | null {
    return this.snapshot;
  }

  async collectNow(): Promise<MetricsSnapshot> {
    if (this.collecting && this.snapshot) {
      return this.snapshot;
    }
    this.collecting = true;
    try {
      const nowMs = this.options.clock.nowMs();
      const { targets, stats } = this.options.targets();
      const pids = targets.map((target) => target.pid);
      const samples = await this.readMetrics(pids);

      const projects: ProjectMetricsPayload[] = targets.map((target) => {
        const sample = samples.get(target.pid);
        let cpuPercent: number | null = null;

        if (sample?.cpuSeconds !== null && sample?.cpuSeconds !== undefined) {
          const previous = this.previous.get(target.pid);
          if (previous) {
            cpuPercent = computeCpuPercent(
              previous.cpuSeconds,
              previous.atMs,
              sample.cpuSeconds,
              nowMs,
              this.cpuCount,
            );
          }
          this.previous.set(target.pid, { cpuSeconds: sample.cpuSeconds, atMs: nowMs });
        }

        return {
          projectId: target.projectId,
          pid: target.pid,
          cpuPercent,
          memoryBytes: sample?.memoryBytes ?? null,
          uptimeMs: target.startedAt ? Math.max(0, nowMs - Date.parse(target.startedAt)) : 0,
        };
      });

      for (const pid of [...this.previous.keys()]) {
        if (!pids.includes(pid)) {
          this.previous.delete(pid);
        }
      }

      const cpuValues = projects
        .map((project) => project.cpuPercent)
        .filter((value): value is number => value !== null);
      const memoryValues = projects
        .map((project) => project.memoryBytes)
        .filter((value): value is number => value !== null);

      const snapshot: MetricsSnapshot = {
        projects,
        system: {
          managedProcesses: stats.managed,
          running: stats.running,
          crashed: stats.crashed,
          cpuPercent:
            cpuValues.length > 0
              ? Math.round(cpuValues.reduce((sum, value) => sum + value, 0) * 10) / 10
              : null,
          memoryBytes:
            memoryValues.length > 0 ? memoryValues.reduce((sum, value) => sum + value, 0) : null,
        },
        collectedAt: this.options.clock.nowIso(),
      };
      this.snapshot = snapshot;

      for (const project of snapshot.projects) {
        this.options.events.emit('project.metrics', project, project.projectId);
      }
      this.options.events.emit('system.metrics', snapshot.system);
      return snapshot;
    } catch (error) {
      this.options.logger.warn('Falha na coleta de métricas', {}, error);
      return (
        this.snapshot ?? {
          projects: [],
          system: {
            managedProcesses: 0,
            running: 0,
            crashed: 0,
            cpuPercent: null,
            memoryBytes: null,
          },
          collectedAt: this.options.clock.nowIso(),
        }
      );
    } finally {
      this.collecting = false;
    }
  }

  private schedule(): void {
    if (!this.running) {
      return;
    }
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      void this.collectNow().finally(() => {
        if (this.running && this.timer === null) {
          this.schedule();
        }
      });
    }, this.intervalMs);
    this.timer.unref();
  }
}
