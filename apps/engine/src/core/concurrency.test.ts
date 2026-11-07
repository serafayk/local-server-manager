import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { runWithConcurrency } from './concurrency';

describe('runWithConcurrency', () => {
  it('respeita o limite de concorrência', async () => {
    let active = 0;
    let peak = 0;

    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(20);
      active -= 1;
      return item * 10;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('preserva a ordem dos resultados mesmo com execução fora de ordem', async () => {
    const results = await runWithConcurrency([50, 10, 30], 3, async (delayMs) => {
      await delay(delayMs);
      return delayMs;
    });
    expect(results).toEqual([50, 10, 30]);
  });

  it('lida com lista vazia', async () => {
    await expect(runWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
