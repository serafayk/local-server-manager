import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, EngineClient } from './api';

const endpoint = {
  baseUrl: 'http://127.0.0.1:5555',
  token: 'token-de-teste',
  websocketPath: '/api/v1/ws',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EngineClient', () => {
  it('envia token, método e caminho corretos', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: [],
        requestId: 'r1',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new EngineClient(endpoint);
    await expect(client.listProjects()).resolves.toEqual([]);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://127.0.0.1:5555/api/v1/projects');
    expect(call[1].method).toBe('GET');
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer token-de-teste');
    expect((call[1].headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(call[1].body).toBeUndefined();
  });

  it('define content-type apenas quando há corpo', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { id: 'p1' },
        requestId: 'r1',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new EngineClient(endpoint);
    await client.createProject({ name: 'X' });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((call[1].headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(call[1].body).toBe(JSON.stringify({ name: 'X' }));
  });

  it('converte envelope de erro em ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            success: false,
            error: { code: 'PROJECT_NOT_FOUND', message: 'não existe' },
            requestId: 'r1',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
          404,
        ),
      ),
    );

    const client = new EngineClient(endpoint);
    try {
      await client.getProject('x');
      throw new Error('esperava ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('PROJECT_NOT_FOUND');
      expect((error as ApiError).message).toBe('não existe');
    }
  });

  it('trata falha de rede', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const client = new EngineClient(endpoint);
    await expect(client.health()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('trata resposta não-JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>erro</html>', { status: 500 })),
    );

    const client = new EngineClient(endpoint);
    await expect(client.health()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('monta query de logs e instância', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { instanceId: 'i1', records: [] },
        requestId: 'r1',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new EngineClient(endpoint);
    await client.getLogs('p1', 42, 'i1');

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://127.0.0.1:5555/api/v1/projects/p1/logs?tail=42&instanceId=i1');
  });
});
