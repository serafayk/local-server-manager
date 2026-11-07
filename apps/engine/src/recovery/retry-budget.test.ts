import { describe, expect, it } from 'vitest';
import { RetryBudget } from './retry-budget';

describe('RetryBudget', () => {
  it('conta falhas consecutivas', () => {
    const budget = new RetryBudget(2);
    expect(budget.attempts).toBe(0);

    expect(budget.registerFailure()).toBe(1);
    expect(budget.canRetry()).toBe(true);
    expect(budget.registerFailure()).toBe(2);
    expect(budget.canRetry()).toBe(true);
    expect(budget.registerFailure()).toBe(3);
    expect(budget.canRetry()).toBe(false);
  });

  it('maxRetries=0 não permite nenhum retry', () => {
    const budget = new RetryBudget(0);
    budget.registerFailure();
    expect(budget.canRetry()).toBe(false);
  });

  it('reset zera o ciclo', () => {
    const budget = new RetryBudget(1);
    budget.registerFailure();
    budget.registerFailure();
    expect(budget.canRetry()).toBe(false);
    budget.reset();
    expect(budget.attempts).toBe(0);
    expect(budget.canRetry()).toBe(true);
  });

  it('atualiza maxRetries sem perder o contador', () => {
    const budget = new RetryBudget(5);
    budget.registerFailure();
    budget.setMaxRetries(0);
    expect(budget.canRetry()).toBe(false);
  });
});
