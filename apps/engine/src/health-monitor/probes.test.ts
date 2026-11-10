import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeHttp, probeTcp } from './probes';

const httpServers: Array<ReturnType<typeof createHttpServer>> = [];
const tcpServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const server of tcpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startHttpServer(status = 200, delayMs = 0): Promise<number> {
  const server = createHttpServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(status);
      response.end('ok');
    }, delayMs);
  });
  httpServers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

async function startTcpServer(): Promise<number> {
  const server = createServer((socket) => socket.end());
  tcpServers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe('probeHttp', () => {
  it('considera saudável o status esperado', async () => {
    const port = await startHttpServer(200);
    const result = await probeHttp(`http://127.0.0.1:${port}/health`, 200, 2_000);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('reprova status diferente do esperado', async () => {
    const port = await startHttpServer(503);
    const result = await probeHttp(`http://127.0.0.1:${port}/health`, 200, 2_000);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.detail).toContain('503');
  });

  it('reprova timeout', async () => {
    const port = await startHttpServer(200, 500);
    const result = await probeHttp(`http://127.0.0.1:${port}/health`, 200, 100);
    expect(result.ok).toBe(false);
  });

  it('reprova conexão recusada', async () => {
    const port = await freePort();
    const result = await probeHttp(`http://127.0.0.1:${port}/health`, 200, 500);
    expect(result.ok).toBe(false);
  });
});

describe('probeTcp', () => {
  it('conecta em porta aberta', async () => {
    const port = await startTcpServer();
    const result = await probeTcp(`127.0.0.1:${port}`, 1_000);
    expect(result.ok).toBe(true);
  });

  it('reprova porta fechada e alvo inválido', async () => {
    // `freePort` devolve uma porta efêmera liberada; outro worker pode
    // reocupá-la entre o bind e o probe, então tentamos algumas vezes.
    let closed = false;
    for (let attempt = 0; attempt < 10 && !closed; attempt += 1) {
      const port = await freePort();
      closed = !(await probeTcp(`127.0.0.1:${port}`, 300)).ok;
    }
    expect(closed).toBe(true);
    expect((await probeTcp('sem-porta', 300)).ok).toBe(false);
  });
});
