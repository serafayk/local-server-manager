import type { RestartPolicy } from '@lsm/contracts';
import { DEFAULT_RESTART_POLICY } from '@lsm/config';
import { FakeClock } from '@lsm/shared';
import { describe, expect, it } from 'vitest';
import { RecoveryManager } from './recovery-manager';

function setup(overrides: Partial<RestartPolicy> = {}) {
  const clock = new FakeClock();
  const retries: number[] = [];
  const stable: number[] = [];
  const policy: RestartPolicy = { ...DEFAULT_RESTART_POLICY, ...overrides };
  const manager = new RecoveryManager({
    clock,
    policy,
    callbacks: {
      onRetry: (attempt) => retries.push(attempt),
      onStable: (previousAttempts) => stable.push(previousAttempts),
    },
    random: () => 0.5,
  });
  return { clock, manager, retries, stable };
}

describe('RecoveryManager', () => {
  it('agenda retry com backoff exponencial', () => {
    const { clock, manager, retries } = setup();

    expect(manager.registerUnexpectedExit()).toEqual({
      action: 'restart',
      attempt: 1,
      delayMs: 2_000,
    });
    clock.advanceBy(1_999);
    expect(retries).toEqual([]);
    clock.advanceBy(1);
    expect(retries).toEqual([1]);

    expect(manager.registerUnexpectedExit()).toEqual({
      action: 'restart',
      attempt: 2,
      delayMs: 4_000,
    });
    clock.advanceBy(4_000);
    expect(retries).toEqual([1, 2]);
  });

  it('esgota o orçamento quando falhas excedem maxRetries', () => {
    const { manager, retries } = setup({ maxRetries: 1, baseDelayMs: 100 });

    expect(manager.registerUnexpectedExit().action).toBe('restart');
    expect(manager.registerUnexpectedExit()).toEqual({
      action: 'exhausted',
      attempt: 2,
      delayMs: 0,
    });
    expect(retries).toEqual([]);
  });

  it('não agenda quando a política está desabilitada', () => {
    const { manager, retries, clock } = setup({ enabled: false });
    expect(manager.registerUnexpectedExit()).toEqual({
      action: 'disabled',
      attempt: 0,
      delayMs: 0,
    });
    clock.advanceBy(120_000);
    expect(retries).toEqual([]);
  });

  it('reset cancela retry pendente e zera o ciclo', () => {
    const { manager, retries, clock } = setup();
    manager.registerUnexpectedExit();
    manager.reset();
    clock.advanceBy(60_000);
    expect(retries).toEqual([]);
    expect(manager.attempts).toBe(0);
  });

  it('reseta o orçamento após estabilidade', () => {
    const { manager, clock, stable } = setup({ stableAfterMs: 60_000 });

    manager.registerUnexpectedExit(); // attempt 1
    clock.advanceBy(2_000); // dispara retry
    manager.markRunning();
    clock.advanceBy(59_999);
    expect(stable).toEqual([]);
    clock.advanceBy(1);
    expect(stable).toEqual([1]);
    expect(manager.attempts).toBe(0);
  });

  it('stableAfterMs=0 desliga o reset automático', () => {
    const { manager, clock, stable } = setup({ stableAfterMs: 0 });
    manager.registerUnexpectedExit();
    clock.advanceBy(2_000);
    manager.markRunning();
    clock.advanceBy(600_000);
    expect(stable).toEqual([]);
    expect(manager.attempts).toBe(1);
  });

  it('cancelamento do retry não afeta a janela de estabilidade já encerrada', () => {
    const { manager, clock, retries, stable } = setup({ stableAfterMs: 10_000 });
    manager.markRunning();
    manager.cancelPendingRetry();
    clock.advanceBy(10_000);
    expect(stable).toEqual([0]);
    expect(retries).toEqual([]);
  });

  it('updatePolicy altera maxRetries', () => {
    const { manager } = setup({ maxRetries: 5 });
    manager.updatePolicy({ ...DEFAULT_RESTART_POLICY, maxRetries: 0 });
    expect(manager.registerUnexpectedExit().action).toBe('exhausted');
  });

  it('dispose cancela timers pendentes', () => {
    const { manager, clock, retries } = setup();
    manager.registerUnexpectedExit();
    manager.dispose();
    clock.advanceBy(60_000);
    expect(retries).toEqual([]);
  });
});
