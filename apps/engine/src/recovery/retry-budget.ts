/**
 * Conta falhas consecutivas e decide se ainda há orçamento de retry.
 *
 * `maxRetries` conta reinícios após a primeira execução: com maxRetries=5,
 * a 1ª falha ainda agenda retry (attempt 1) e a 6ª esgota.
 */
export class RetryBudget {
  private failures = 0;
  private maxRetries: number;

  constructor(maxRetries: number) {
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
  }

  get attempts(): number {
    return this.failures;
  }

  registerFailure(): number {
    this.failures += 1;
    return this.failures;
  }

  canRetry(): boolean {
    return this.failures <= this.maxRetries;
  }

  reset(): void {
    this.failures = 0;
  }

  setMaxRetries(maxRetries: number): void {
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
  }
}
