import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { LoggingConfig, LogRecord, LogStream, ProjectConfig } from '@lsm/contracts';
import type { Clock, Logger } from '@lsm/shared';
import { redactText } from '@lsm/shared';
import type { EventBus } from '../core/event-bus';
import { LineDecoder } from './line-decoder';
import { InstanceLogWriter } from './log-writer';
import { RingBuffer } from './ring-buffer';

const DEFAULT_MAX_LINE_LENGTH = 8 * 1024;
const DEFAULT_RING_CAPACITY = 2_000;
const MAX_TAIL_BYTES = 512 * 1024;

export interface LogManagerOptions {
  logsDir: string;
  clock: Clock;
  logger: Logger;
  events: EventBus;
  maxLineLength?: number;
  ringCapacity?: number;
}

interface StreamState {
  lineDecoder: LineDecoder;
  textDecoder: StringDecoder;
}

interface InstanceState {
  projectId: string;
  instanceId: string;
  captureOutput: boolean;
  maskPatterns: string[];
  fileBasePath: string;
  writer: InstanceLogWriter;
  ring: RingBuffer<LogRecord>;
  streams: Map<LogStream, StreamState>;
  sequence: number;
  closed: boolean;
}

/**
 * Captura stdout/stderr, monta linhas, grava JSONL e mantém ring buffer para
 * a UI. Falha de escrita de log nunca derruba o Engine.
 */
export class LogManager {
  private readonly instances = new Map<string, InstanceState>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly maxLineLength: number;
  private readonly ringCapacity: number;

  constructor(private readonly options: LogManagerOptions) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY;
  }

  registerInstance(project: ProjectConfig, instanceId: string): void {
    if (this.instances.has(instanceId)) {
      return;
    }
    const logging: LoggingConfig = project.logging;
    const fileBasePath = join(this.options.logsDir, project.id, `${instanceId}.log`);

    let writer: InstanceLogWriter;
    try {
      writer = new InstanceLogWriter({
        basePath: fileBasePath,
        maxFileSizeMb: logging.maxFileSizeMb,
        onError: (error) => {
          this.options.logger.error(
            'Falha ao escrever arquivo de log',
            { projectId: project.id, instanceId },
            error,
          );
        },
        onDrop: (dropped) => {
          this.options.logger.warn('Buffer de log cheio; linhas descartadas na gravação', {
            projectId: project.id,
            instanceId,
            dropped,
          });
        },
      });
    } catch (error) {
      this.options.logger.error(
        'Não foi possível abrir arquivo de log; continuando apenas em memória',
        { projectId: project.id, instanceId },
        error,
      );
      writer = new InstanceLogWriter({
        basePath: join(this.options.logsDir, project.id, `${instanceId}.fallback.log`),
        maxFileSizeMb: 1,
        onError: () => undefined,
      });
    }

    this.instances.set(instanceId, {
      projectId: project.id,
      instanceId,
      captureOutput: logging.captureOutput,
      maskPatterns: logging.maskPatterns,
      fileBasePath,
      writer,
      ring: new RingBuffer<LogRecord>(this.ringCapacity),
      streams: new Map(),
      sequence: 0,
      closed: false,
    });
  }

  push(
    projectId: string,
    instanceId: string,
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string,
  ): void {
    const state = this.instances.get(instanceId);
    if (!state || state.closed || !state.captureOutput || state.projectId !== projectId) {
      return;
    }
    const streamState = this.streamState(state, stream);

    if (typeof chunk === 'string') {
      streamState.lineDecoder.push(chunk);
      return;
    }
    // StringDecoder evita corromper caracteres UTF-8 partidos entre chunks.
    const text = streamState.textDecoder.write(chunk);
    if (text.length > 0) {
      streamState.lineDecoder.push(text);
    }
  }

  /** Linha de sistema associada a uma instância (start/stop/crash). */
  recordSystem(projectId: string, instanceId: string, message: string): void {
    const state = this.instances.get(instanceId);
    if (!state || state.closed) {
      this.options.logger.debug('Evento de sistema sem instância ativa', { projectId, message });
      return;
    }
    this.append(state, 'system', message, false);
  }

  tail(projectId: string, instanceId: string, limit: number): LogRecord[] {
    const state = this.instances.get(instanceId);
    if (state && !state.closed) {
      return state.ring.toArray().slice(-limit);
    }
    return readJsonlTail(join(this.options.logsDir, projectId, `${instanceId}.log`), limit).map(
      (record) => ({ ...record, projectId, instanceId }),
    );
  }

  async closeInstance(instanceId: string): Promise<void> {
    const existing = this.closing.get(instanceId);
    if (existing) {
      return existing;
    }
    const promise = this.doCloseInstance(instanceId);
    this.closing.set(instanceId, promise);
    return promise;
  }

  private async doCloseInstance(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state || state.closed) {
      return;
    }
    for (const streamState of state.streams.values()) {
      streamState.lineDecoder.flush();
    }
    state.closed = true;
    state.ring.clear();
    await state.writer.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.instances.keys()].map((instanceId) => this.closeInstance(instanceId)),
    );
  }

  logFileFor(projectId: string, instanceId: string): string {
    const state = this.instances.get(instanceId);
    return state
      ? state.writer.filePath
      : join(this.options.logsDir, projectId, `${instanceId}.log`);
  }

  /** Instâncias cujo arquivo ainda pode estar aberto (proteção da retenção). */
  activeInstanceIds(): string[] {
    return [...this.instances.values()]
      .filter((state) => !state.closed)
      .map((state) => state.instanceId);
  }

  private streamState(state: InstanceState, stream: 'stdout' | 'stderr'): StreamState {
    const existing = state.streams.get(stream);
    if (existing) {
      return existing;
    }
    const created: StreamState = {
      textDecoder: new StringDecoder('utf8'),
      lineDecoder: new LineDecoder({
        maxLineLength: this.maxLineLength,
        onLine: (text, truncated) => this.append(state, stream, text, truncated),
      }),
    };
    state.streams.set(stream, created);
    return created;
  }

  private append(state: InstanceState, stream: LogStream, text: string, truncated: boolean): void {
    if (state.closed) {
      return;
    }
    state.sequence += 1;
    const record: LogRecord = {
      projectId: state.projectId,
      instanceId: state.instanceId,
      sequence: state.sequence,
      stream,
      timestamp: this.options.clock.nowIso(),
      text: redactText(text, state.maskPatterns),
      truncated,
    };

    state.writer.write({
      ts: record.timestamp,
      seq: record.sequence,
      stream: record.stream,
      text: record.text,
      truncated: record.truncated ? 1 : 0,
    });
    state.ring.push(record);
    this.options.events.emit('project.log', record, state.projectId);
  }
}

interface JsonlLine {
  ts?: unknown;
  seq?: unknown;
  stream?: unknown;
  text?: unknown;
  truncated?: unknown;
}

function readJsonlTail(filePath: string, limit: number): LogRecord[] {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }
  if (size === 0) {
    return [];
  }

  const start = Math.max(0, size - MAX_TAIL_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  try {
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }

  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) {
    lines.shift(); // primeira linha pode estar truncada no meio
  }

  const records: LogRecord[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(line) as JsonlLine;
    } catch {
      continue;
    }
    if (typeof parsed.seq !== 'number' || typeof parsed.text !== 'string') {
      continue;
    }
    records.push({
      projectId: '',
      instanceId: '',
      sequence: parsed.seq,
      stream: normalizeStream(parsed.stream),
      timestamp: typeof parsed.ts === 'string' ? parsed.ts : '',
      text: parsed.text,
      truncated: parsed.truncated === 1,
    });
  }
  return records.slice(-limit);
}

function normalizeStream(value: unknown): LogStream {
  return value === 'stderr' || value === 'system' ? value : 'stdout';
}
