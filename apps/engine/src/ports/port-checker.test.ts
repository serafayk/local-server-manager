import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPort, isPortFree, parseNetstatOwner } from './port-checker';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function listenOnFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('sem endereço'));
        return;
      }
      servers.push(server);
      resolve(address.port);
    });
  });
}

describe('port-checker', () => {
  it('detecta porta livre', async () => {
    const port = await listenOnFreePort();
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    expect(await isPortFree(port)).toBe(true);
    const check = await checkPort(port);
    expect(check).toEqual({ port, inUse: false, ownerPid: null });
  });

  it('detecta porta ocupada e o PID dono', async () => {
    const port = await listenOnFreePort();

    expect(await isPortFree(port)).toBe(false);
    const check = await checkPort(port);
    expect(check.inUse).toBe(true);
    if (process.platform === 'win32') {
      expect(check.ownerPid).toBe(process.pid);
    }
  });

  it('parseia a saída do netstat', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242',
      '  TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       5555',
      '  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     6666',
      '  TCP    [::]:7000              [::]:0                 LISTENING       7777',
    ].join('\r\n');

    expect(parseNetstatOwner(output, 3_000)).toBe(4_242);
    expect(parseNetstatOwner(output, 4_000)).toBe(5_555);
    expect(parseNetstatOwner(output, 7_000)).toBe(7_777);
    expect(parseNetstatOwner(output, 5_000)).toBeNull();
    expect(parseNetstatOwner(output, 9_999)).toBeNull();
  });
});
