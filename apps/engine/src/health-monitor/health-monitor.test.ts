import type { HealthCheckConfig } from '@lsm/contracts';
import { createSystemClock } from '@lsm/shared';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../../../../tests/helpers';
import { HealthMonitor } from './health-monitor';

function makeConfig(overrides: Partial<HealthCheckConfig> = {}): HealthCheckConfig {
  return {
    enabled: true,
    type: 'http',
    target: 'http://127.0.0.1:1/health',
    expectedStatus: 200,
    intervalMs: 25,
    timeoutMs: 100,
    failureThreshold: 2,
    restartOnUnhealthy: false,
    unhealthyRestartCooldownMs: 10_000,
    ...overrides,
  };
}

function setup(
  config: Partial<HealthCheckConfig> = {},
  initialOk = true,
): {
  monitor: HealthMonitor;
  changes: Array<{ health: string; detail: string }>;
  restarts: string[];
  setOk: (value: boolean) => void;
} {
  const changes: Array<{ health: string; detail: string }> = [];
  const restarts: string[] = [];
  let ok = initialOk;

  const monitor = new HealthMonitor({
    config: makeConfig(config),
    clock: createSystemClock(),
    probe: async () => ({ ok, detail: ok ? 'ok' : 'falhou' }),
    onChanged: (health, detail) => changes.push({ health, detail }),
    onRestartRequested: (detail) => restarts.push(detail),
  });

  return {
    monitor,
    changes,
    restarts,
    setOk: (value) => {
      ok = value;
    },
  };
}

describe('HealthMonitor', () => {
  it('marca HEALTHY no primeiro probe bem-sucedido', async () => {
    const { monitor, changes } = setup();
    try {
      monitor.start();
      await waitFor(() => changes.some((change) => change.health === 'HEALTHY'), {
        description: 'HEALTHY',
      });
    } finally {
      monitor.stop();
    }
  });

  it('só marca UNHEALTHY após o failureThreshold', async () => {
    let calls = 0;
    let ok = true;
    let callsAtUnhealthy = -1;
    const changes: string[] = [];

    const monitor = new HealthMonitor({
      config: makeConfig({ failureThreshold: 2, intervalMs: 20 }),
      clock: createSystemClock(),
      probe: async () => {
        calls += 1;
        return { ok, detail: ok ? 'ok' : 'falhou' };
      },
      onChanged: (health) => {
        changes.push(health);
        if (health === 'HEALTHY') {
          // a partir daqui todas as probes falham
          ok = false;
        }
        if (health === 'UNHEALTHY') {
          callsAtUnhealthy = calls;
        }
      },
      onRestartRequested: () => undefined,
    });

    try {
      monitor.start();
      await waitFor(() => changes.includes('UNHEALTHY'), {
        timeoutMs: 2_000,
        description: 'UNHEALTHY após 2 falhas',
      });
      // 1 probe saudável + 2 falhas consecutivas
      expect(callsAtUnhealthy).toBe(3);
    } finally {
      monitor.stop();
    }
  });

  it('recupera para HEALTHY após falha', async () => {
    const { monitor, changes, setOk } = setup({ failureThreshold: 1 }, true);
    try {
      monitor.start();
      await waitFor(() => changes.some((change) => change.health === 'HEALTHY'), {
        description: 'HEALTHY',
      });
      setOk(false);
      await waitFor(() => changes.some((change) => change.health === 'UNHEALTHY'), {
        description: 'UNHEALTHY',
      });
      setOk(true);
      await waitFor(() => changes.filter((change) => change.health === 'HEALTHY').length >= 2, {
        description: 'recuperado',
      });
    } finally {
      monitor.stop();
    }
  });

  it('solicita restart uma vez por cooldown', async () => {
    const { monitor, restarts, setOk } = setup(
      { failureThreshold: 1, restartOnUnhealthy: true, unhealthyRestartCooldownMs: 10_000 },
      true,
    );
    try {
      monitor.start();
      setOk(false);
      await waitFor(() => restarts.length === 1, { description: 'restart solicitado' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(restarts).toHaveLength(1);
    } finally {
      monitor.stop();
    }
  });

  it('não inicia quando desabilitado', async () => {
    const { monitor, changes } = setup({ enabled: false }, true);
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes).toHaveLength(0);
    monitor.stop();
  });

  it('para de agendar após stop', async () => {
    const { monitor, changes } = setup();
    monitor.start();
    monitor.stop();
    const count = changes.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes.length).toBe(count);
  });
});
