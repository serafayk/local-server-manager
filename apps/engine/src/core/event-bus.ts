import type {
  AnyDomainEvent,
  DomainEvent,
  DomainEventPayloads,
  DomainEventType,
} from '@lsm/contracts';
import { PROTOCOL_VERSION } from '@lsm/contracts';
import type { Clock, Logger } from '@lsm/shared';
import { newId } from '@lsm/shared';

export type Unsubscribe = () => void;

type AnyHandler = (event: DomainEvent) => void;

/**
 * Barramento de eventos de domínio. Handlers nunca derrubam o emissor:
 * uma exceção em assinante é logada e isolada.
 */
export class EventBus {
  private readonly handlers = new Map<DomainEventType, Set<AnyHandler>>();
  private readonly anyHandlers = new Set<AnyHandler>();

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  on<K extends DomainEventType>(type: K, handler: (event: DomainEvent<K>) => void): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<AnyHandler>();
    set.add(handler as AnyHandler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as AnyHandler);
    };
  }

  off<K extends DomainEventType>(type: K, handler: (event: DomainEvent<K>) => void): void {
    this.handlers.get(type)?.delete(handler as AnyHandler);
  }

  /** Assina todos os eventos (usado pelo gateway WebSocket). */
  onAny(handler: (event: AnyDomainEvent) => void): Unsubscribe {
    this.anyHandlers.add(handler as unknown as AnyHandler);
    return () => {
      this.anyHandlers.delete(handler as unknown as AnyHandler);
    };
  }

  /** Cria o envelope sem despachar (snapshots enviados a um cliente novo). */
  build<K extends DomainEventType>(
    type: K,
    payload: DomainEventPayloads[K],
    projectId?: string,
  ): DomainEvent<K> {
    return {
      eventId: newId(),
      protocolVersion: PROTOCOL_VERSION,
      type,
      timestamp: this.clock.nowIso(),
      payload,
      ...(projectId !== undefined ? { projectId } : {}),
    };
  }

  emit<K extends DomainEventType>(
    type: K,
    payload: DomainEventPayloads[K],
    projectId?: string,
  ): DomainEvent<K> {
    const event = this.build(type, payload, projectId);

    const subscribers = this.handlers.get(type);
    if (subscribers) {
      for (const handler of subscribers) {
        this.safeCall(handler, event as DomainEvent);
      }
    }
    for (const handler of this.anyHandlers) {
      try {
        handler(event as AnyDomainEvent);
      } catch (error) {
        this.logger.error('Falha em assinante de evento', { eventType: event.type }, error);
      }
    }
    return event;
  }

  private safeCall(handler: AnyHandler, event: DomainEvent): void {
    try {
      handler(event);
    } catch (error) {
      this.logger.error('Falha em assinante de evento', { eventType: event.type }, error);
    }
  }

  listenerCount(type?: DomainEventType): number {
    if (type) {
      return this.handlers.get(type)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.handlers.values()) {
      total += set.size;
    }
    return total;
  }

  clear(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }
}
