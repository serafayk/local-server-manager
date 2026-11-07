import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationQueue } from './operation-queue';

describe('OperationQueue', () => {
  it('executa tarefas na ordem de chegada', async () => {
    const queue = new OperationQueue();
    const order: number[] = [];

    const first = queue.run(async () => {
      await delay(30);
      order.push(1);
    });
    const second = queue.run(async () => {
      order.push(2);
    });
    const third = queue.run(async () => {
      order.push(3);
    });

    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('não bloqueia a fila após uma falha', async () => {
    const queue = new OperationQueue();
    const executed: string[] = [];

    const failing = queue.run(async () => {
      executed.push('falha');
      throw new Error('boom');
    });
    const next = queue.run(async () => {
      executed.push('seguinte');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(executed).toEqual(['falha', 'seguinte']);
  });

  it('expõe tamanho pendente e whenIdle', async () => {
    const queue = new OperationQueue();
    const task = queue.run(async () => {
      await delay(20);
    });
    expect(queue.pending).toBe(1);
    await task;
    expect(queue.pending).toBe(0);
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });
});
