import type { AnyDomainEvent } from '@lsm/contracts';
import type { EngineEndpoint } from './api';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface SocketHandlers {
  onEvent: (event: AnyDomainEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
}

const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * WebSocket com reconexão exponencial. Ao reconectar, o consumidor deve
 * recarregar o histórico (o Engine não guarda cursor global).
 */
export class EngineSocket {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(
    private readonly endpoint: EngineEndpoint,
    private readonly handlers: SocketHandlers,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    if (this.stopped) {
      return;
    }
    this.handlers.onStatus('connecting');

    const url = `${this.endpoint.baseUrl.replace(/^http/, 'ws')}${
      this.endpoint.websocketPath
    }${this.endpoint.token === '' ? '' : `?token=${encodeURIComponent(this.endpoint.token)}`}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.handlers.onStatus('closed');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.handlers.onStatus('open');
    });

    socket.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(String(message.data)) as AnyDomainEvent;
        if (event && typeof event.type === 'string') {
          this.handlers.onEvent(event);
        }
      } catch {
        // Frame inválido é ignorado; não derruba o fluxo.
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.handlers.onStatus('closed');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // O evento 'close' vem em seguida e agenda a reconexão.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.attempts, MAX_RECONNECT_DELAY_MS);
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}
