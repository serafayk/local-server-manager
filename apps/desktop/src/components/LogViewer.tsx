import type { LogRecord } from '@lsm/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { formatTime } from '../lib/format';

const STREAM_CLASS: Record<LogRecord['stream'], string> = {
  stdout: 'text-zinc-400',
  stderr: 'text-red-300',
  system: 'text-sky-300',
};

export function LogViewer({
  records,
  autoScroll = true,
  emptyMessage = 'Nenhum log ainda. Inicie o projeto para ver a saída.',
  heightClass = 'h-[55vh]',
}: {
  records: LogRecord[];
  autoScroll?: boolean;
  emptyMessage?: string;
  heightClass?: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 30,
  });

  useEffect(() => {
    if (autoScroll && records.length > 0) {
      virtualizer.scrollToIndex(records.length - 1, { align: 'end' });
    }
  }, [records.length, autoScroll, virtualizer]);

  if (records.length === 0) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-black/40 p-6 text-xs text-zinc-500 ${heightClass}`}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className={`overflow-auto rounded-lg border border-zinc-800 bg-black/70 ${heightClass}`}
      aria-label="Logs do processo"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const record = records[item.index];
          if (!record) {
            return null;
          }
          return (
            <div
              key={item.key}
              className="absolute left-0 top-0 flex w-full gap-2 whitespace-pre px-2 text-xs leading-5"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <span className="shrink-0 text-zinc-600">{formatTime(record.timestamp)}</span>
              <span className={`shrink-0 uppercase ${STREAM_CLASS[record.stream]}`}>
                {record.stream}
              </span>
              <span
                className={
                  record.stream === 'stderr'
                    ? 'text-red-200'
                    : record.truncated
                      ? 'text-amber-300'
                      : 'text-zinc-200'
                }
              >
                {record.text}
                {record.truncated ? ' [truncado]' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
