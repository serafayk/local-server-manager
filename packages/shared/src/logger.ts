import { appendFileSync, mkdirSync, renameSync, statSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { redactValue } from './redact';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogMeta = Record<string, unknown>;

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta, cause?: unknown): void;
  error(message: string, meta?: LogMeta, cause?: unknown): void;
  child(bindings: LogMeta): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  base?: LogMeta;
  sinks?: LogSink[];
}

function safeStringify(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Error) {
      return serializeError(value);
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        return '[CIRCULAR]';
      }
      seen.add(value);
    }
    return value;
  });
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if ('code' in error && typeof error.code === 'string') {
    serialized.code = error.code;
  }
  if (error.stack) {
    serialized.stack = error.stack;
  }
  return serialized;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const minimum = LEVEL_WEIGHT[level];
  const sinks = options.sinks ?? [createStreamSink(process.stdout)];
  const base = options.base ?? {};

  const emit = (entryLevel: LogLevel, message: string, meta?: LogMeta, cause?: unknown): void => {
    if (LEVEL_WEIGHT[entryLevel] < minimum) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...base,
      ...(meta ? (redactValue(meta) as Record<string, unknown>) : {}),
    };
    if (cause !== undefined) {
      record.err = cause instanceof Error ? serializeError(cause) : redactValue(cause);
    }
    let line: string;
    try {
      line = safeStringify(record);
    } catch {
      line = JSON.stringify({ level: entryLevel, msg: message, err: 'SERIALIZATION_FAILED' });
    }
    for (const sink of sinks) {
      try {
        sink.write(line);
      } catch {
        // Um sink com falha nunca pode derrubar o Engine.
      }
    }
  };

  const logger: Logger = {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta, cause) => emit('warn', message, meta, cause),
    error: (message, meta, cause) => emit('error', message, meta, cause),
    child: (bindings) =>
      createLogger({
        level,
        base: { ...base, ...bindings },
        sinks,
      }),
  };

  return logger;
}

export function createStreamSink(stream: NodeJS.WritableStream): LogSink {
  return {
    write(line: string) {
      stream.write(`${line}\n`);
    },
  };
}

/**
 * Sink de arquivo com rotação simples por tamanho. Usa escrita síncrona
 * porque o volume do plano de controle é baixo e perder log de auditoria em
 * crash é pior que o custo de I/O.
 */
export function createFileSink(filePath: string, options: { maxBytes?: number } = {}): LogSink {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  mkdirSync(dirname(filePath), { recursive: true });

  const readSize = (): number => {
    try {
      const stat: Stats = statSync(filePath);
      return stat.size;
    } catch {
      return 0;
    }
  };

  let size = readSize();

  return {
    write(line: string) {
      const payload = `${line}\n`;
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (size > 0 && size + bytes > maxBytes) {
        try {
          renameSync(filePath, `${filePath}.1`);
        } catch {
          // Se a rotação falhar, continua escrevendo no arquivo atual.
        }
        size = 0;
      }
      try {
        appendFileSync(filePath, payload, 'utf8');
        size += bytes;
      } catch {
        // Falha de I/O de log não é fatal.
      }
    },
  };
}

export function createNoopSink(): LogSink {
  return { write: () => undefined };
}
