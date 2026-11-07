import type { DomainEvent, DomainEventPayloads, DomainEventType } from '@lsm/contracts';
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

  emit<K extends DomainEventType>(
    type: K,
    payload: DomainEventPayloads[K],
    projectId?: string,
  ): DomainEvent<K> {
    const event: DomainEvent<K> = {
      eventId: newId(),
      protocolVersion: PROTOCOL_VERSION,
      type,
      timestamp: this.clock.nowIso(),
      payload,
      ...(projectId !== undefined ? { projectId } : {}),
    };

    const subscribers = this.handlers.get(type);
    if (!subscribers) {
      return event;
    }
    for (const handler of subscribers) {
      try {
        handler(event as DomainEvent);
      } catch (error) {
        this.logger.error('Falha em assinante de evento', { eventType: type }, error);
      }
    }
    return event;
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
  }
}
