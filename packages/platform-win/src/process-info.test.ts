import { describe, expect, it } from 'vitest';
import { getProcessStartTimeIso, isProcessAlive, pidMatchesStartTime } from './process-info';

describe('process-info', () => {
  it('detecta o próprio processo como vivo', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('trata PID inválido como inexistente', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });

  it('obtém StartTime em ISO para processo vivo', async () => {
    const iso = await getProcessStartTimeIso(process.pid);
    expect(iso).not.toBeNull();
    expect(Number.isNaN(Date.parse(iso as string))).toBe(false);
  });

  it('confirma propriedade apenas quando StartTime coincide', async () => {
    const iso = await getProcessStartTimeIso(process.pid);
    expect(iso).not.toBeNull();
    expect(await pidMatchesStartTime(process.pid, iso as string)).toBe(true);
    expect(await pidMatchesStartTime(process.pid, '2000-01-01T00:00:00.000Z')).toBe(false);
  });

  it('retorna null para PID inexistente', async () => {
    expect(await getProcessStartTimeIso(999_998)).toBeNull();
  });
});
