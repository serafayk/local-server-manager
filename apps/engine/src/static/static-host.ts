import { createReadStream, statSync, type Stats } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export interface StaticHostEntry {
  projectId: string;
  root: string;
  port: number;
}

/**
 * Serve arquivos estáticos no próprio processo do Engine (sem processo extra).
 * Cada projeto ganha um `http.Server` em 127.0.0.1:<porta>.
 */
export class StaticHostManager {
  private readonly servers = new Map<string, Server>();

  isRunning(projectId: string): boolean {
    return this.servers.has(projectId);
  }

  async start(entry: StaticHostEntry): Promise<void> {
    if (this.servers.has(entry.projectId)) {
      return;
    }
    const root = resolve(entry.root);
    const server = createServer((request, response) => {
      serveRequest(root, request, response);
    });

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        server.close();
        reject(error);
      };
      server.once('error', onError);
      server.listen(entry.port, '127.0.0.1', () => {
        server.off('error', onError);
        resolvePromise();
      });
    });

    this.servers.set(entry.projectId, server);
  }

  async stop(projectId: string): Promise<void> {
    const server = this.servers.get(projectId);
    if (!server) {
      return;
    }
    this.servers.delete(projectId);
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((projectId) => this.stop(projectId)));
  }
}

function serveRequest(root: string, request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Method Not Allowed');
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad Request');
    return;
  }

  const relative = pathname.replace(/^\/+/, '');
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  let file = candidate;
  let stats = safeStat(file);
  if (stats?.isDirectory()) {
    file = resolve(file, 'index.html');
    stats = safeStat(file);
  }

  // SPA fallback: rotas sem extensão caem no index.html.
  if ((stats === null || !stats.isFile()) && extname(relative) === '') {
    file = resolve(root, 'index.html');
    stats = safeStat(file);
  }

  if (stats === null || !stats.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const type = MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const isHtml = type.startsWith('text/html');
  response.writeHead(200, {
    'content-type': type,
    'content-length': stats.size,
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    response.end('Internal Server Error');
  });
  stream.pipe(response);
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path) as Stats;
  } catch {
    return null;
  }
}
