import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

async function bootEngine(webDir: string | null = null): Promise<Engine> {
  const dataDir = createTempDir('lsm-web-');
  const engine = createEngine({ dataDir, singleInstance: false, logger, webDir });
  await engine.start();
  cleanups.unshift(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return engine;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.shift();
    if (cleanup) {
      await cleanup();
    }
  }
});

function apiOf(engine: Engine): string {
  const api = engine.info().api;
  if (!api) {
    throw new Error('API indisponível');
  }
  return api.baseUrl;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  csrf?: string;
}

async function call(
  baseUrl: string,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; json: unknown; cookies: string[] }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (options.csrf) {
    headers['x-csrf-token'] = options.csrf;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = text;
  }
  return {
    status: response.status,
    json,
    cookies: response.headers.getSetCookie?.() ?? [],
  };
}

function cookiePair(cookies: string[], name: string): string {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`cookie ${name} ausente`);
  }
  return found.split(';')[0] as string;
}

describe('Web UI e autenticação', () => {
  it('serve a UI sem autenticação e protege a API por cookie', async () => {
    const webDir = createTempDir('lsm-web-assets-');
    cleanups.push(async () => removeTempDir(webDir));
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(webDir, 'index.html'), '<h1>painel</h1>', 'utf8');

    const engine = await bootEngine(webDir);
    const base = apiOf(engine);

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('painel');

    const status = await call(base, '/api/v1/auth/status');
    expect((status.json as { data: unknown }).data).toMatchObject({
      configured: false,
      authenticated: false,
    });

    const blocked = await call(base, '/api/v1/projects');
    expect(blocked.status).toBe(401);

    const setup = await call(base, '/api/v1/auth/setup', {
      method: 'POST',
      body: { password: 'senha-forte-123' },
    });
    expect(setup.status).toBe(200);
    const session = cookiePair(setup.cookies, 'lsm_session');
    const csrf = decodeURIComponent(
      (cookiePair(setup.cookies, 'lsm_csrf').split('=')[1] ?? '') as string,
    );

    const list = await call(base, '/api/v1/projects', { cookie: session });
    expect(list.status).toBe(200);

    const withoutCsrf = await call(base, '/api/v1/projects', {
      method: 'POST',
      cookie: session,
      body: { name: 'x', workingDirectory: 'C:\\x', runtime: { executable: 'node', args: [] } },
    });
    expect(withoutCsrf.status).toBe(403);

    const withCsrf = await call(base, '/api/v1/projects', {
      method: 'POST',
      cookie: session,
      csrf,
      body: {
        name: 'web-project',
        workingDirectory: 'C:\\laragon\\www',
        runtime: { executable: 'node', args: [] },
      },
    });
    expect(withCsrf.status).toBe(201);
  }, 30_000);

  it('faz login, rejeita senha errada e encerra a sessão', async () => {
    const engine = await bootEngine();
    const base = apiOf(engine);

    const setup = await call(base, '/api/v1/auth/setup', {
      method: 'POST',
      body: { password: 'outra-senha-123' },
    });
    expect(setup.status).toBe(200);

    const logout = await call(base, '/api/v1/auth/logout', {
      method: 'POST',
      cookie: cookiePair(setup.cookies, 'lsm_session'),
    });
    expect(logout.status).toBe(200);

    const wrong = await call(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { password: 'errada' },
    });
    expect(wrong.status).toBe(401);

    const login = await call(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { password: 'outra-senha-123' },
    });
    expect(login.status).toBe(200);
    expect(cookiePair(login.cookies, 'lsm_session')).toContain('lsm_session=');
  }, 30_000);
});
