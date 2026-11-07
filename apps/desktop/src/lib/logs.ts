import type { LogRecord } from '@lsm/contracts';

/**
 * Combina histórico (HTTP) e fluxo ao vivo (WebSocket) sem duplicar linhas.
 * O WebSocket entrega eventos que podem já estar no `tail` consultado.
 */
export function mergeLogRecords(
  history: readonly LogRecord[],
  live: readonly LogRecord[],
  instanceId: string | null,
): LogRecord[] {
  const bySequence = new Map<number, LogRecord>();
  for (const record of history) {
    if (instanceId === null || record.instanceId === instanceId) {
      bySequence.set(record.sequence, record);
    }
  }
  for (const record of live) {
    if (instanceId === null || record.instanceId === instanceId) {
      bySequence.set(record.sequence, record);
    }
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

export function filterLogRecords(
  records: readonly LogRecord[],
  options: { stream: 'all' | LogRecord['stream']; search: string },
): LogRecord[] {
  const needle = options.search.trim().toLowerCase();
  return records.filter((record) => {
    if (options.stream !== 'all' && record.stream !== options.stream) {
      return false;
    }
    if (needle !== '' && !record.text.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });
}
