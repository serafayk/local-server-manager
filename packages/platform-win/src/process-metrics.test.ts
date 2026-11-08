import { describe, expect, it } from 'vitest';
import { parseProcessMetricsJson } from './process-metrics';

describe('parseProcessMetricsJson', () => {
  it('parseia objeto único', () => {
    expect(parseProcessMetricsJson('{"Id":1,"CPU":2.5,"WorkingSet64":1024}')).toEqual([
      { pid: 1, cpuSeconds: 2.5, memoryBytes: 1_024 },
    ]);
  });

  it('parseia array de processos', () => {
    const raw = JSON.stringify([
      { Id: 10, CPU: 1, WorkingSet64: 2048 },
      { Id: 20, CPU: 2, WorkingSet64: 4096 },
    ]);
    expect(parseProcessMetricsJson(raw)).toEqual([
      { pid: 10, cpuSeconds: 1, memoryBytes: 2_048 },
      { pid: 20, cpuSeconds: 2, memoryBytes: 4_096 },
    ]);
  });

  it('trata campos ausentes como null', () => {
    expect(parseProcessMetricsJson('{"Id":7}')).toEqual([
      { pid: 7, cpuSeconds: null, memoryBytes: null },
    ]);
  });

  it('ignora entrada vazia e JSON inválido', () => {
    expect(parseProcessMetricsJson('')).toEqual([]);
    expect(parseProcessMetricsJson('não é json')).toEqual([]);
    expect(parseProcessMetricsJson('null')).toEqual([]);
  });

  it('ignora processos sem Id válido', () => {
    expect(parseProcessMetricsJson('[{"CPU":1},{"Id":0},{"Id":3}]')).toEqual([
      { pid: 3, cpuSeconds: null, memoryBytes: null },
    ]);
  });
});
