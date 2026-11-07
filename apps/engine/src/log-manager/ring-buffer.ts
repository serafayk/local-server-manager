/** Buffer circular de capacidade fixa para visualização em memória. */
export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error('RingBuffer exige capacidade >= 1');
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
