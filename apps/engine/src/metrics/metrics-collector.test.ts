import { FakeClock, createLogger, createNoopSink } from '@lsm/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/event-bus';
import { MetricsCollector, computeCpuPercent } from './metrics-collector';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });

describe('computeCpuPercent', () => {
  it('calcula percentual normalizado por núcleo', () => {
    // 1s de CPU em 1s de parede com 2 núcleos = 50%
    expect(computeCpuPercent(10, 0, 11, 1_000, 2)).toBe(50);
    // 2s de CPU em 1s com 2 núcleos = 100% (teto)
    expect(computeCpuPercent(10, 0, 12, 1_000, 2)).toBe(100);
  });

  it('retorna null para delta inválido', () => {
    expect(computeCpuPercent(10, 1_000, 11, 1_000, 2)).toBeNull();
    expect(computeCpuPercent(10, 0, 9, 1_000, 2)).toBeNull();
  });
});

describe('MetricsCollector', () => {
  it('primeira amostra não tem CPU e emite eventos', async () => {
    const clock = new FakeClock();
    const events = new EventBus(clock, logger);
    const received: string[] = [];
    events.on('project.metrics', () => received.push('project'));
    events.on('system.metrics', () => received.push('system'));

    let cpuSeconds = 10;
    const collector = new MetricsCollector({
      clock,
      logger,
      events,
      intervalMs: 5_000,
      cpuCount: 2,
      targets: () => ({
        targets: [{ projectId: 'p1', pid: 100, startedAt: '2026-01-01T00:00:00.000Z' }],
        stats: { managed: 1, running: 1, crashed: 0 },
      }),
      readMetrics: async () =>
        new Map([
          [
            100,
            {
              pid: 100,
              cpuSeconds,
              memoryBytes: 2_048,
              privateBytes: 1_536,
              processCount: 3,
              processes: [{ pid: 101, name: 'node.exe', memoryBytes: 1_024 }],
            },
          ],
        ]),
    });

    const first = await collector.collectNow();
    expect(first.projects[0]).toMatchObject({
      projectId: 'p1',
      pid: 100,
      cpuPercent: null,
      memoryBytes: 2_048,
      privateBytes: 1_536,
      processCount: 3,
    });
    expect(first.projects[0]?.processes).toEqual([
      { pid: 101, name: 'node.exe', memoryBytes: 1_024 },
    ]);
    expect(first.system).toMatchObject({
      managedProcesses: 1,
      running: 1,
      memoryBytes: 2_048,
    });
    expect(received).toEqual(['project', 'system']);

    clock.advanceBy(1_000);
    cpuSeconds = 11;
    const second = await collector.collectNow();
    expect(second.projects[0]?.cpuPercent).toBe(50);
    expect(second.system.cpuPercent).toBe(50);
  });

  it('mantém última amostra em falha de leitura', async () => {
    const clock = new FakeClock();
    const events = new EventBus(clock, logger);
    let fail = false;
    const collector = new MetricsCollector({
      clock,
      logger,
      events,
      intervalMs: 5_000,
      targets: () => ({
        targets: [{ projectId: 'p1', pid: 100, startedAt: null }],
        stats: { managed: 1, running: 1, crashed: 0 },
      }),
      readMetrics: async () => {
        if (fail) {
          throw new Error('falha');
        }
        return new Map([[100, { pid: 100, cpuSeconds: 5, memoryBytes: 1_024 }]]);
      },
    });

    const first = await collector.collectNow();
    expect(first.projects).toHaveLength(1);
    fail = true;
    const second = await collector.collectNow();
    expect(second).toBe(first);
  });

  it('start/stop não deixa timers pendentes', () => {
    const clock = new FakeClock();
    const events = new EventBus(clock, logger);
    const collector = new MetricsCollector({
      clock,
      logger,
      events,
      intervalMs: 5_000,
      targets: () => ({ targets: [], stats: { managed: 0, running: 0, crashed: 0 } }),
      readMetrics: async () => new Map(),
    });

    collector.start();
    expect(clock.pendingTimers()).toBe(1);
    collector.stop();
    expect(clock.pendingTimers()).toBe(0);
  });
});
