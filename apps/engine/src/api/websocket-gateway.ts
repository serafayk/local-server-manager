import type { DomainEvent } from '@lsm/contracts';
import type { Logger } from '@lsm/shared';
import type { EventBus } from '../core/event-bus';
import type { Supervisor } from '../supervisor/supervisor';

/** Interface mínima do WebSocket que o gateway precisa (evita acoplar a `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'close' | 'error' | 'message' | 'pong', listener: (...args: unknown[]) => void): void;
}

interface Client {
  socket: WebSocketLike;
  droppedLogs: number;
  alive: boolean;
}

export interface WebSocketGatewayOptions {
  events: EventBus;
  supervisor: Supervisor;
  logger: Logger;
  heartbeatIntervalMs?: number;
  /** Acima disso, eventos de log passam a ser descartados para o cliente. */
  maxBufferedBytes?: number;
}

const CLOSE_GOING_AWAY = 1001;
const CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * Distribui eventos de domínio para os clientes WebSocket.
 *
 * Estratégia de reconexão: o cliente busca o histórico via HTTP
 * (`/projects/:id/logs`) e recebe snapshots atuais ao conectar. O WebSocket
 * entrega apenas o fluxo ao vivo.
 */
export class WebSocketGateway {
  private readonly clients = new Set<Client>();
  private readonly events: EventBus;
  private readonly supervisor: Supervisor;
  private readonly logger: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBufferedBytes: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: WebSocketGatewayOptions) {
    this.events = options.events;
    this.supervisor = options.supervisor;
    this.logger = options.logger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  }

  start(): void {
    this.unsubscribe = this.events.onAny((event) => this.broadcast(event));
    this.heartbeat = setInterval(() => this.pingClients(), this.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  attach(socket: WebSocketLike): void {
    const client: Client = { socket, droppedLogs: 0, alive: true };
    this.clients.add(client);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      this.clients.delete(client);
    });
    socket.on('error', (error) => {
      this.logger.warn('Erro em cliente WebSocket', {}, error);
      this.clients.delete(client);
    });

    // Snapshot inicial: o cliente não precisa esperar o próximo evento.
    for (const summary of this.supervisor.listSummaries()) {
      this.send(
        client,
        this.events.build('project.state.changed', {
          snapshot: summary.runtime,
          previousStatus: summary.runtime.status,
        }),
      );
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) {
      try {
        client.socket.close(CLOSE_GOING_AWAY, 'engine shutdown');
      } catch {
        // Conexão já encerrada.
      }
    }
    this.clients.clear();
  }

  private broadcast(event: DomainEvent): void {
    for (const client of this.clients) {
      if (client.socket.readyState !== 1) {
        this.clients.delete(client);
        continue;
      }

      if (event.type === 'project.log') {
        if (client.socket.bufferedAmount > this.maxBufferedBytes) {
          client.droppedLogs += 1;
          continue;
        }
        if (client.droppedLogs > 0 && client.socket.bufferedAmount < this.maxBufferedBytes / 4) {
          this.send(
            client,
            this.events.build('engine.notice', {
              level: 'warn',
              code: 'LOG_BACKPRESSURE',
              message: `${client.droppedLogs} evento(s) de log descartado(s) por backpressure; use o histórico HTTP.`,
            }),
          );
          client.droppedLogs = 0;
        }
      }

      this.send(client, event);
    }
  }

  private send(client: Client, event: DomainEvent): void {
    try {
      client.socket.send(JSON.stringify(event));
    } catch (error) {
      this.clients.delete(client);
      this.logger.warn('Falha ao enviar evento WebSocket', { eventType: event.type }, error);
    }
  }

  private pingClients(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        try {
          client.socket.close(CLOSE_TRY_AGAIN_LATER, 'heartbeat timeout');
          client.socket.terminate();
        } catch {
          // ignore
        }
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
