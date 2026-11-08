import {
  createServer as createHttpServer,
  request as httpRequest,
  Agent,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, type Server as NetServer } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@lsm/shared';
import type { CertificateManager } from './certificate-manager';

const MAX_PORT_ATTEMPTS = 20;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyTarget {
  projectId: string;
  projectName: string;
  status: string;
  /** `null` quando o projeto não tem porta fixa configurada. */
  port: number | null;
}

export interface ProxyPorts {
  httpPort: number;
  httpsPort: number;
}

export interface ProxyManagerOptions {
  logger: Logger;
  certificates: CertificateManager;
  resolve: (host: string) => ProxyTarget | null;
}

export interface ProxyListenOptions {
  httpPort: number;
  httpsPort: number;
}

/**
 * Proxy reverso local: um único ponto em 127.0.0.1 roteia por `Host` para os
 * projetos gerenciados. Não abre porta em interfaces externas.
 */
export class ProxyManager {
  private httpServer: Server | null = null;
  private httpsServer: HttpsServer | null = null;
  private portsValue: ProxyPorts = { httpPort: 0, httpsPort: 0 };
  private readonly agent = new Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    maxSockets: 128,
  });

  constructor(private readonly options: ProxyManagerOptions) {}

  get ports(): ProxyPorts {
    return this.portsValue;
  }

  get listening(): { http: boolean; https: boolean } {
    return {
      http: this.httpServer?.listening === true,
      https: this.httpsServer?.listening === true,
    };
  }

  async start(requested: ProxyListenOptions): Promise<ProxyPorts> {
    if (this.httpServer || this.httpsServer) {
      return this.portsValue;
    }

    const defaultPair = await this.options.certificates.defaultPair();

    const httpServer = createHttpServer((request, response) => {
      this.handleRequest(request, response, 'http', this.portsValue.httpPort);
    });
    httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head, 'http');
    });
    httpServer.on('clientError', (error, socket) => {
      this.options.logger.debug('Erro de cliente no proxy HTTP', { error: String(error) });
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    httpServer.requestTimeout = 0;
    httpServer.headersTimeout = 60_000;
    httpServer.keepAliveTimeout = 65_000;

    const httpsServer = createHttpsServer(
      {
        key: defaultPair.key,
        cert: defaultPair.cert,
        SNICallback: (servername, callback) => {
          void this.options.certificates
            .contextFor(servername)
            .then((context) => callback(null, context))
            .catch((error: unknown) => callback(error as Error));
        },
      },
      (request, response) => {
        this.handleRequest(request, response, 'https', this.portsValue.httpsPort);
      },
    );
    httpsServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head, 'https');
    });
    httpsServer.on('tlsClientError', (error) => {
      this.options.logger.debug('Handshake TLS rejeitado no proxy', { error: String(error) });
    });
    httpsServer.requestTimeout = 0;
    httpsServer.headersTimeout = 60_000;
    httpsServer.keepAliveTimeout = 65_000;

    this.httpServer = httpServer;
    this.httpsServer = httpsServer;

    try {
      const httpPort = await listenWithFallback(httpServer, requested.httpPort);
      this.portsValue = { ...this.portsValue, httpPort };
      const httpsPort = await listenWithFallback(httpsServer, requested.httpsPort);
      this.portsValue = { httpPort, httpsPort };
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.options.logger.info('Proxy de domínios ativo', {
      httpPort: this.portsValue.httpPort,
      httpsPort: this.portsValue.httpsPort,
    });
    return this.portsValue;
  }

  async stop(): Promise<void> {
    const servers: Array<Server | HttpsServer> = [];
    if (this.httpServer) {
      servers.push(this.httpServer);
    }
    if (this.httpsServer) {
      servers.push(this.httpsServer);
    }
    this.httpServer = null;
    this.httpsServer = null;
    this.agent.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolvePromise) => {
            server.closeAllConnections();
            server.close(() => resolvePromise());
          }),
      ),
    );
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    scheme: 'http' | 'https',
    listenPort: number,
  ): void {
    const host = normalizeHostHeader(request.headers.host);
    if (host === null) {
      writeErrorPage(response, 400, 'Host ausente', 'A requisição não informou o cabeçalho Host.');
      return;
    }

    const target = this.options.resolve(host);
    if (target === null) {
      writeErrorPage(
        response,
        404,
        `Domínio "${host}" não configurado`,
        'Cadastre o domínio na página Domínios do Local Server Manager.',
      );
      return;
    }
    if (target.port === null) {
      writeErrorPage(
        response,
        502,
        `Projeto "${target.projectName}" sem porta`,
        'Defina uma porta fixa no projeto (ou na rota) para o proxy encaminhar o tráfego.',
      );
      return;
    }
    const targetPort = target.port;

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) {
        continue;
      }
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin') {
        continue;
      }
      headers[lower] = value;
    }
    headers.host = `127.0.0.1:${targetPort}`;
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-proto'] = scheme;
    headers['x-forwarded-port'] = String(listenPort);
    headers['x-forwarded-for'] = '127.0.0.1';
    if (request.headers.origin !== undefined) {
      // Mantém Host e Origin coerentes para apps que validam CSRF.
      headers.origin = `http://127.0.0.1:${targetPort}`;
    }

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: request.method,
        path: request.url ?? '/',
        headers,
        agent: this.agent,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.on('error', () => response.destroy());
      },
    );

    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const refused = error.code === 'ECONNREFUSED';
      writeErrorPage(
        response,
        refused ? 502 : 504,
        refused ? 'Projeto não está respondendo' : 'Falha ao falar com o projeto',
        refused
          ? `"${target.projectName}" está ${target.status} em 127.0.0.1:${targetPort}. Inicie o projeto e recarregue.`
          : error.message,
        { host, project: target.projectName, port: targetPort },
      );
    });

    request.pipe(upstream);
    request.on('aborted', () => upstream.destroy());
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    scheme: 'http' | 'https',
  ): void {
    const host = normalizeHostHeader(request.headers.host);
    const target = host === null ? null : this.options.resolve(host);
    if (target === null || target.port === null) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstream = netConnect(target.port, '127.0.0.1');
    upstream.on('connect', () => {
      const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];
        if (name === undefined || value === undefined) {
          continue;
        }
        const lower = name.toLowerCase();
        if (lower === 'host') {
          lines.push(`host: 127.0.0.1:${target.port}`);
        } else if (lower === 'origin') {
          lines.push(`origin: http://127.0.0.1:${target.port}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push(`x-forwarded-host: ${host}`);
      lines.push(`x-forwarded-proto: ${scheme}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }
}

function normalizeHostHeader(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  // IPv6 literal chega como [::1]:8090
  const withoutPort = value.startsWith('[')
    ? (value.slice(0, value.indexOf(']') + 1) ?? value)
    : (value.split(':')[0] ?? value);
  const normalized = withoutPort.trim().toLowerCase().replace(/\.$/, '');
  return normalized === '' ? null : normalized;
}

async function listenWithFallback(server: NetServer, requested: number): Promise<number> {
  let lastError: unknown = null;
  for (let offset = 0; offset <= MAX_PORT_ATTEMPTS; offset += 1) {
    const candidate = requested === 0 ? 0 : requested + offset;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      const address = server.address() as AddressInfo | null;
      return address?.port ?? candidate;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || requested === 0) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error('Nenhuma porta disponível para o proxy');
}

function writeErrorPage(
  response: ServerResponse,
  status: number,
  title: string,
  detail: string,
  meta: { host?: string; project?: string; port?: number } = {},
): void {
  const escape = (value: string): string =>
    value.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return entities[character] ?? character;
    });

  const rows = [
    meta.host ? `<p><strong>Domínio:</strong> ${escape(meta.host)}</p>` : '',
    meta.project ? `<p><strong>Projeto:</strong> ${escape(meta.project)}</p>` : '',
    meta.port ? `<p><strong>Destino:</strong> 127.0.0.1:${meta.port}</p>` : '',
  ].join('');

  const body = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${status} — Local Server Manager</title>
<style>
body{font-family:ui-sans-serif,system-ui,Segoe UI,sans-serif;background:#09090b;color:#e4e4e7;margin:0;padding:48px}
main{max-width:640px;margin:0 auto;border:1px solid #27272a;border-radius:12px;padding:28px;background:#18181b}
h1{font-size:18px;margin:0 0 8px}
p{line-height:1.6;color:#a1a1aa;margin:8px 0}
code{background:#27272a;padding:2px 6px;border-radius:4px;color:#e4e4e7}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#3f1d1d;color:#fca5a5;margin-bottom:12px}
</style></head><body><main>
<span class="badge">${status}</span>
<h1>${escape(title)}</h1>
<p>${escape(detail)}</p>
${rows}
</main></body></html>`;

  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}
