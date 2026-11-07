import { describe, expect, it } from 'vitest';
import { computeBackoffDelay } from './backoff-policy';

const base = { baseDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0 };

describe('computeBackoffDelay', () => {
  it('cresce exponencialmente a partir da tentativa 1', () => {
    expect(computeBackoffDelay({ ...base, attempt: 1 })).toBe(1_000);
    expect(computeBackoffDelay({ ...base, attempt: 2 })).toBe(2_000);
    expect(computeBackoffDelay({ ...base, attempt: 3 })).toBe(4_000);
    expect(computeBackoffDelay({ ...base, attempt: 4 })).toBe(8_000);
  });

  it('respeita o teto maxDelayMs', () => {
    expect(computeBackoffDelay({ ...base, attempt: 10 })).toBe(30_000);
    expect(
      computeBackoffDelay({ baseDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0, attempt: 6 }),
    ).toBe(5_000);
  });

  it('trata tentativa inválida como 1', () => {
    expect(computeBackoffDelay({ ...base, attempt: 0 })).toBe(1_000);
    expect(computeBackoffDelay({ ...base, attempt: -3 })).toBe(1_000);
  });

  it('aplica jitter simétrico limitado ao teto', () => {
    expect(computeBackoffDelay({ ...base, attempt: 1, jitterRatio: 0.15, random: () => 1 })).toBe(
      1_150,
    );
    expect(computeBackoffDelay({ ...base, attempt: 1, jitterRatio: 0.15, random: () => 0 })).toBe(
      850,
    );
    expect(
      computeBackoffDelay({
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        attempt: 1,
        jitterRatio: 0.5,
        random: () => 1,
      }),
    ).toBe(1_000);
  });
});
