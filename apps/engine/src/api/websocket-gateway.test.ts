import type { LogRecord, ProjectSummary, RuntimeSnapshot } from '@lsm/contracts';
import { FakeClock, createLogger, createNoopSink } from '@lsm/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/event-bus';
import type { Supervisor } from '../supervisor/supervisor';
import { WebSocketGateway, type WebSocketLike } from './websocket-gateway';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });

class FakeSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    for (const handler of this.handlers.get('close') ?? []) {
      handler();
    }
  }

  terminate(): void {
    this.readyState = 3;
  }

  ping(): void {
    // no-op
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(listener);
    this.handlers.set(event, handlers);
  }
}

function makeSnapshot(projectId: string, status: RuntimeSnapshot['status']): RuntimeSnapshot {
  return {
    projectId,
    status,
    desiredState: 'STOPPED',
    health: 'UNKNOWN',
    instanceId: null,
    pid: null,
    startedAt: null,
    restartAttempt: 0,
    lastExit: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeLog(sequence: number): LogRecord {
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

function setup(snapshots: RuntimeSnapshot[] = []) {
  const clock = new FakeClock();
  const events = new EventBus(clock, logger);
  const supervisor = {
    listSummaries: () => snapshots.map((runtime) => ({ runtime }) as unknown as ProjectSummary),
  } as unknown as Supervisor;

  const gateway = new WebSocketGateway({
    events,
    supervisor,
    logger,
    heartbeatIntervalMs: 60_000,
    maxBufferedBytes: 1_000,
  });
  gateway.start();
  return { gateway, events };
}

describe('WebSocketGateway', () => {
  it('envia snapshots ao conectar', () => {
    const { gateway } = setup([makeSnapshot('p1', 'RUNNING')]);
    const socket = new FakeSocket();

    gateway.attach(socket);

    expect(socket.sent).toHaveLength(1);
    const event = JSON.parse(socket.sent[0] as string) as {
      type: string;
      payload: { snapshot: RuntimeSnapshot };
    };
    expect(event.type).toBe('project.state.changed');
    expect(event.payload.snapshot.status).toBe('RUNNING');
    expect(gateway.clientCount()).toBe(1);
    gateway.closeAll();
  });

  it('transmite eventos de domínio', () => {
    const { gateway, events } = setup();
    const socket = new FakeSocket();
    gateway.attach(socket);

    events.emit('project.log', makeLog(1), 'p1');

    expect(socket.sent).toHaveLength(1);
    expect((JSON.parse(socket.sent[0] as string) as { type: string }).type).toBe('project.log');
    gateway.closeAll();
  });

  it('descarta logs sob backpressure e avisa quando normaliza', () => {
    const { gateway, events } = setup();
    const socket = new FakeSocket();
    gateway.attach(socket);

    socket.bufferedAmount = 5_000;
    events.emit('project.log', makeLog(1), 'p1');
    events.emit('project.log', makeLog(2), 'p1');
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    events.emit('project.log', makeLog(3), 'p1');

    const parsed = socket.sent.map(
      (line) => JSON.parse(line) as { type: string; payload: { code?: string } },
    );
    expect(parsed.map((event) => event.type)).toEqual(['engine.notice', 'project.log']);
    expect(parsed[0]?.payload.code).toBe('LOG_BACKPRESSURE');
    gateway.closeAll();
  });

  it('remove cliente que fechou e encerra todos no closeAll', () => {
    const { gateway } = setup();
    const first = new FakeSocket();
    const second = new FakeSocket();
    gateway.attach(first);
    gateway.attach(second);
    expect(gateway.clientCount()).toBe(2);

    first.close();
    expect(gateway.clientCount()).toBe(1);

    gateway.closeAll();
    expect(second.closed?.code).toBe(1001);
    expect(gateway.clientCount()).toBe(0);
  });
});
