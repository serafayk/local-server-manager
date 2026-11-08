import { describe, expect, it } from 'vitest';
import { aggregateProcessTrees, parseProcessMetricsJson } from './process-metrics';

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

describe('aggregateProcessTrees', () => {
  const rows = [
    {
      ProcessId: 100,
      ParentProcessId: 1,
      Name: 'node.exe',
      WorkingSetSize: 10_000,
      PrivatePageCount: 8_000,
      KernelModeTime: '1000000',
      UserModeTime: '1000000',
    },
    {
      ProcessId: 200,
      ParentProcessId: 100,
      Name: 'node.exe',
      WorkingSetSize: 40_000,
      PrivatePageCount: 30_000,
      KernelModeTime: 2_000_000,
      UserModeTime: 3_000_000,
    },
    {
      ProcessId: 300,
      ParentProcessId: 200,
      Name: 'node.exe',
      WorkingSetSize: 5_000,
      PrivatePageCount: 4_000,
      KernelModeTime: 0,
      UserModeTime: 0,
    },
    {
      ProcessId: 400,
      ParentProcessId: 1,
      Name: 'outro.exe',
      WorkingSetSize: 99_000,
      PrivatePageCount: 99_000,
      KernelModeTime: 0,
      UserModeTime: 0,
    },
    {
      ProcessId: 500,
      ParentProcessId: 100,
      Name: 'conhost.exe',
      WorkingSetSize: 7_000_000,
      PrivatePageCount: 7_000_000,
      KernelModeTime: 0,
      UserModeTime: 0,
    },
  ];

  it('soma a árvore inteira e ignora processos fora dela', () => {
    const result = aggregateProcessTrees(rows, [100]);
    const sample = result.get(100);

    expect(sample).toMatchObject({
      pid: 100,
      memoryBytes: 55_000,
      privateBytes: 42_000,
      processCount: 3,
    });
    // 0,2s + 0,5s = 0,7s de CPU acumulada na árvore.
    expect(sample?.cpuSeconds).toBeCloseTo(0.7, 5);
    expect(sample?.processes?.map((process) => process.pid)).toEqual([200, 100, 300]);
  });

  it('aceita estrutura aninhada repetida sem contar duas vezes', () => {
    // 300 aparece como filho de 200 e de 100 (dado inconsistente do SO).
    const duplicated = [
      ...rows,
      {
        ProcessId: 300,
        ParentProcessId: 100,
        Name: 'node.exe',
        WorkingSetSize: 5_000,
        PrivatePageCount: 4_000,
        KernelModeTime: 0,
        UserModeTime: 0,
      },
    ];
    const sample = aggregateProcessTrees(duplicated, [100]).get(100);
    expect(sample?.processCount).toBe(3);
    expect(sample?.memoryBytes).toBe(55_000);
  });

  it('retorna null quando o PID raiz não existe mais', () => {
    const sample = aggregateProcessTrees(rows, [999]).get(999);
    expect(sample).toMatchObject({
      pid: 999,
      memoryBytes: null,
      privateBytes: null,
      processCount: 0,
    });
    expect(sample?.processes).toEqual([]);
  });

  it('lida com JSON inválido e lista vazia', () => {
    expect(aggregateProcessTrees('não é json', [100]).size).toBe(0);
    expect(aggregateProcessTrees('', [100]).size).toBe(0);
    expect(aggregateProcessTrees([], [100]).get(100)?.processCount).toBe(0);
  });
});
