import type { LogRecord } from '@lsm/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_LIVE_LOGS, useAppStore } from './app-store';

function record(sequence: number): LogRecord {
  return {
    projectId: 'p1',
    instanceId: 'i1',
    sequence,
    stream: 'stdout',
    timestamp: '2026-01-01T00:00:00.000Z',
    text: `linha ${sequence}`,
    truncated: false,
  };
}

beforeEach(() => {
  useAppStore.setState({ connection: 'idle', logsByProject: {} });
});

describe('useAppStore', () => {
  it('acumula logs por projeto', () => {
    useAppStore.getState().appendLog(record(1));
    useAppStore.getState().appendLog(record(2));

    expect(useAppStore.getState().logsByProject.p1?.map((item) => item.text)).toEqual([
      'linha 1',
      'linha 2',
    ]);
  });

  it('respeita o limite do buffer ao vivo', () => {
    for (let index = 1; index <= MAX_LIVE_LOGS + 10; index += 1) {
      useAppStore.getState().appendLog(record(index));
    }
    const logs = useAppStore.getState().logsByProject.p1 ?? [];
    expect(logs).toHaveLength(MAX_LIVE_LOGS);
    expect(logs[logs.length - 1]?.sequence).toBe(MAX_LIVE_LOGS + 10);
  });

  it('limpa logs de um projeto sem afetar os demais', () => {
    useAppStore.getState().appendLog(record(1));
    useAppStore.getState().appendLog({ ...record(2), projectId: 'p2' });

    useAppStore.getState().clearLogs('p1');

    expect(useAppStore.getState().logsByProject.p1).toBeUndefined();
    expect(useAppStore.getState().logsByProject.p2).toHaveLength(1);
  });

  it('atualiza o estado da conexão', () => {
    useAppStore.getState().setConnection('open');
    expect(useAppStore.getState().connection).toBe('open');
  });
});
