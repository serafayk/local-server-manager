import type { LogRecord } from '@lsm/contracts';
import { describe, expect, it } from 'vitest';
import { filterLogRecords, mergeLogRecords } from './logs';

function record(sequence: number, text: string, overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    projectId: 'p1',
    instanceId: 'i1',
    sequence,
    stream: 'stdout',
    timestamp: '2026-01-01T00:00:00.000Z',
    text,
    truncated: false,
    ...overrides,
  };
}

describe('mergeLogRecords', () => {
  it('une histórico e ao vivo sem duplicar sequence', () => {
    const history = [record(1, 'a'), record(2, 'b')];
    const live = [record(2, 'b2'), record(3, 'c')];

    const merged = mergeLogRecords(history, live, 'i1');
    expect(merged.map((item) => item.text)).toEqual(['a', 'b2', 'c']);
    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it('filtra pela instância selecionada', () => {
    const history = [record(1, 'a'), record(2, 'x', { instanceId: 'i2' })];
    const merged = mergeLogRecords(history, [], 'i1');
    expect(merged.map((item) => item.text)).toEqual(['a']);
  });

  it('inclui todas as instâncias quando instanceId é null', () => {
    const history = [record(1, 'a'), record(2, 'x', { instanceId: 'i2' })];
    expect(mergeLogRecords(history, [], null)).toHaveLength(2);
  });
});

describe('filterLogRecords', () => {
  const records = [
    record(1, 'listening on 3000'),
    record(2, 'boom', { stream: 'stderr' }),
    record(3, 'start solicitado', { stream: 'system' }),
  ];

  it('filtra por stream', () => {
    expect(filterLogRecords(records, { stream: 'stderr', search: '' }).map((r) => r.text)).toEqual([
      'boom',
    ]);
  });

  it('filtra por texto sem diferenciar caixa', () => {
    expect(
      filterLogRecords(records, { stream: 'all', search: 'LISTENING' }).map((r) => r.text),
    ).toEqual(['listening on 3000']);
  });

  it('combina stream e busca', () => {
    expect(filterLogRecords(records, { stream: 'stdout', search: 'boom' })).toHaveLength(0);
  });
});
