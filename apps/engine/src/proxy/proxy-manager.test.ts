import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { CertificateManager } from './certificate-manager';
import { ProxyManager, type ProxyTarget } from './proxy-manager';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];
const certsDir = createTempDir('lsm-proxy-certs-');

let echo: Server;
let echoPort = 0;
let proxy: ProxyManager;
let httpPort = 0;
let httpsPort = 0;
let closedPort = 0;

interface ProxyResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function httpGet(
  port: number,
  host: string,
  path = '/',
  headers: Record<string, string> = {},
): Promise<ProxyResponse> {
  return new Promise<ProxyResponse>((resolvePromise, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host, ...headers } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolvePromise({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function httpsGet(port: number, host: string, path = '/'): Promise<ProxyResponse> {
  return new Promise<ProxyResponse>((resolvePromise, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        servername: host,
        rejectUnauthorized: false,
        headers: { host },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolvePromise({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

beforeAll(async () => {
  echo = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        path: request.url,
        host: request.headers.host,
        forwardedHost: request.headers['x-forwarded-host'],
        forwardedProto: request.headers['x-forwarded-proto'],
        origin: request.headers.origin ?? null,
      }),
    );
  });
  const wss = new WebSocketServer({ server: echo, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolvePromise) => echo.listen(0, '127.0.0.1', resolvePromise));
  echoPort = (echo.address() as { port: number }).port;

  // Porta comprovadamente fechada para o cenário 502.
  const closed = createTcpServer();
  await new Promise<void>((resolvePromise) => closed.listen(0, '127.0.0.1', resolvePromise));
  closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((resolvePromise) => closed.close(() => resolvePromise()));

  const certificates = new CertificateManager({ certsDir, logger });
  const targets: Record<string, ProxyTarget> = {
    'app.lsm': { projectId: 'p1', projectName: 'App', status: 'RUNNING', port: echoPort },
    'dead.lsm': { projectId: 'p2', projectName: 'Parado', status: 'STOPPED', port: closedPort },
    'semporta.lsm': { projectId: 'p3', projectName: 'Sem porta', status: 'RUNNING', port: null },
  };
  proxy = new ProxyManager({
    logger,
    certificates,
    resolve: (host) => targets[host] ?? null,
  });
  const ports = await proxy.start({ httpPort: 0, httpsPort: 0 });
  httpPort = ports.httpPort;
  httpsPort = ports.httpsPort;
});

afterAll(async () => {
  await proxy?.stop();
  await new Promise<void>((resolvePromise) => echo?.close(() => resolvePromise()));
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  removeTempDir(certsDir);
});

describe('proxy de domínios', () => {
  it('roteia por Host e preserva o host original em x-forwarded-host', async () => {
    const response = await httpGet(httpPort, 'app.lsm', '/api/status?x=1');
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      path: string;
      host: string;
      forwardedHost: string;
      forwardedProto: string;
    };
    expect(payload.path).toBe('/api/status?x=1');
    expect(payload.host).toBe(`127.0.0.1:${echoPort}`);
    expect(payload.forwardedHost).toBe('app.lsm');
    expect(payload.forwardedProto).toBe('http');
  });

  it('reescreve Origin para o destino local', async () => {
    const response = await httpGet(httpPort, 'app.lsm', '/', { origin: 'http://app.lsm:8090' });
    const payload = JSON.parse(response.body) as { origin: string };
    expect(payload.origin).toBe(`http://127.0.0.1:${echoPort}`);
  });

  it('responde 404 para host não cadastrado', async () => {
    const response = await httpGet(httpPort, 'nao-existe.lsm');
    expect(response.status).toBe(404);
    expect(response.body).toContain('não configurado');
  });

  it('responde 502 quando o projeto está parado', async () => {
    const response = await httpGet(httpPort, 'dead.lsm');
    expect(response.status).toBe(502);
    expect(response.body).toContain('não está respondendo');
  });

  it('responde 502 explicativo quando o projeto não tem porta', async () => {
    const response = await httpGet(httpPort, 'semporta.lsm');
    expect(response.status).toBe(502);
    expect(response.body).toContain('sem porta');
  });

  it('atende HTTPS com SNI do domínio', async () => {
    const response = await httpsGet(httpsPort, 'app.lsm', '/secure');
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { forwardedProto: string };
    expect(payload.forwardedProto).toBe('https');
  });

  it('encaminha WebSocket (upgrade)', async () => {
    const result = await new Promise<string>((resolvePromise, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`, {
        headers: { host: 'app.lsm' },
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('timeout no WebSocket'));
      }, 5_000);
      socket.on('open', () => socket.send('ping'));
      socket.on('message', (data) => {
        clearTimeout(timer);
        socket.close();
        resolvePromise(data.toString());
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(result).toBe('echo:ping');
  });

  it('pula para a próxima porta quando a preferida está ocupada', async () => {
    const occupied = createTcpServer();
    await new Promise<void>((resolvePromise) => occupied.listen(0, '127.0.0.1', resolvePromise));
    const busyPort = (occupied.address() as { port: number }).port;

    const other = new ProxyManager({
      logger,
      certificates: new CertificateManager({ certsDir, logger }),
      resolve: () => null,
    });
    const ports = await other.start({ httpPort: busyPort, httpsPort: 0 });
    expect(ports.httpPort).toBeGreaterThan(busyPort);
    await other.stop();
    await new Promise<void>((resolvePromise) => occupied.close(() => resolvePromise()));
  });
});
