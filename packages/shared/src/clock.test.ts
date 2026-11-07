import { describe, expect, it } from 'vitest';
import { FakeClock, createSystemClock } from './clock';

describe('FakeClock', () => {
  it('começa no instante informado', () => {
    const clock = new FakeClock('2026-05-01T10:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-05-01T10:00:00.000Z');
  });

  it('executa timers vencidos em ordem cronológica', () => {
    const clock = new FakeClock();
    const order: string[] = [];

    clock.setTimeout(() => order.push('300ms'), 300);
    clock.setTimeout(() => order.push('100ms'), 100);
    clock.setTimeout(() => order.push('200ms'), 200);

    clock.advanceBy(250);
    expect(order).toEqual(['100ms', '200ms']);

    clock.advanceBy(100);
    expect(order).toEqual(['100ms', '200ms', '300ms']);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('clearTimeout cancela o timer', () => {
    const clock = new FakeClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 100);
    clock.clearTimeout(handle);
    clock.advanceBy(1_000);
    expect(fired).toBe(false);
  });

  it('não executa timers no futuro', () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 5_000);
    clock.advanceBy(4_999);
    expect(fired).toBe(false);
    expect(clock.pendingTimers()).toBe(1);
  });
});

describe('createSystemClock', () => {
  it('expõe tempo real em ISO e ms', () => {
    const clock = createSystemClock();
    expect(typeof clock.nowMs()).toBe('number');
    expect(clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
