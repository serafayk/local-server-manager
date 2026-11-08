import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DetectProjectResponse,
  EngineApiInfo,
  EngineInfo,
  EngineSettings,
  OperationResult,
  ProjectConfig,
  ProjectGroup,
  ProjectSummary,
  RuntimeSnapshot,
  ScanRootResponse,
  TunnelSummary,
} from '@lsm/contracts';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  createTempDir,
  fixturePath,
  removeTempDir,
  waitFor,
} from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];
let counter = 0;

async function boot(): Promise<{ engine: Engine; api: EngineApiInfo }> {
  const dataDir = createTempDir('lsm-api-');
  const engine = createEngine({ dataDir, singleInstance: false, logger });
  await engine.start();
  const api = engine.info().api;
  if (!api) {
    throw new Error('API local não iniciou');
  }
  cleanups.push(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return { engine, api };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

async function apiCall<T>(
  api: EngineApiInfo,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; result: OperationResult<T> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${api.token}`,
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    result: (await response.json()) as OperationResult<T>,
  };
}

function expectData<T>(result: OperationResult<T>): T {
  if (!result.success) {
    throw new Error(`Esperava sucesso: ${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

function fixtureProjectBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  return {
    name: `api-${counter}-${Date.now()}`,
    workingDirectory: FIXTURES_DIR,
    runtime: { executable: process.execPath, args: [fixturePath('http-server.mjs')] },
    shutdown: { gracefulTimeoutMs: 1_000 },
    ...overrides,
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('sem endereço'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function websocketUrl(api: EngineApiInfo): string {
  return `${api.baseUrl.replace('http://', 'ws://')}${api.websocketPath}?token=${encodeURIComponent(api.token)}`;
}

interface WsMessage {
  type: string;
  payload: {
    snapshot?: RuntimeSnapshot;
    text?: string;
    code?: string;
  };
}

describe('API local — autenticação e envelope', () => {
  it('rejeita requisição sem token e com token inválido', async () => {
    const { api } = await boot();

    const withoutToken = await fetch(`${api.baseUrl}/api/v1/health`);
    expect(withoutToken.status).toBe(401);
    const body = (await withoutToken.json()) as OperationResult<unknown>;
    expect(body.success).toBe(false);
    if (!body.success) {
      expect(body.error.code).toBe('UNAUTHORIZED');
    }

    const wrongToken = await fetch(`${api.baseUrl}/api/v1/health`, {
      headers: { authorization: 'Bearer token-errado' },
    });
    expect(wrongToken.status).toBe(401);
  });

  it('rejeita protocolo incompatível', async () => {
    const { api } = await boot();
    const { status, result } = await apiCall(api, 'GET', '/api/v1/health', undefined, {
      'x-protocol-version': '99',
    });
    expect(status).toBe(409);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PROTOCOL_VERSION_MISMATCH');
    }
  });

  it('expõe health e info com a porta real', async () => {
    const { api } = await boot();

    const health = await apiCall<{ status: string; pid: number }>(api, 'GET', '/api/v1/health');
    expect(health.status).toBe(200);
    const healthData = expectData(health.result);
    expect(healthData.status).toBe('ok');
    expect(healthData.pid).toBe(process.pid);

    const info = await apiCall<EngineInfo>(api, 'GET', '/api/v1/info');
    const infoData = expectData(info.result);
    expect(infoData.api?.port).toBe(api.port);
    expect(infoData.protocolVersion).toBe(1);
  });

  it('responde 404 com código estável em rota desconhecida', async () => {
    const { api } = await boot();
    const { status, result } = await apiCall(api, 'GET', '/api/v1/nao-existe');
    expect(status).toBe(404);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('ROUTE_NOT_FOUND');
    }
  });

  it('aplica CORS apenas para origens permitidas', async () => {
    const { api } = await boot();

    const allowed = await fetch(`${api.baseUrl}/api/v1/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:1420',
        'access-control-request-method': 'GET',
      },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');

    const denied = await fetch(`${api.baseUrl}/api/v1/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('API local — projetos', () => {
  it('faz CRUD completo', async () => {
    const { api } = await boot();

    const created = await apiCall<ProjectConfig>(
      api,
      'POST',
      '/api/v1/projects',
      fixtureProjectBody({ name: 'API CRUD' }),
    );
    expect(created.status).toBe(201);
    const project = expectData(created.result);

    const list = await apiCall<ProjectSummary[]>(api, 'GET', '/api/v1/projects');
    expect(expectData(list.result).some((item) => item.config.id === project.id)).toBe(true);

    const detail = await apiCall<ProjectSummary>(api, 'GET', `/api/v1/projects/${project.id}`);
    expect(expectData(detail.result).config.name).toBe('API CRUD');

    const updated = await apiCall<ProjectConfig>(api, 'PUT', `/api/v1/projects/${project.id}`, {
      name: 'API CRUD editado',
      restartPolicy: { maxRetries: 2 },
    });
    const updatedProject = expectData(updated.result);
    expect(updatedProject.name).toBe('API CRUD editado');
    expect(updatedProject.restartPolicy.maxRetries).toBe(2);

    const removed = await apiCall<{ name: string }>(
      api,
      'DELETE',
      `/api/v1/projects/${project.id}`,
    );
    expect(expectData(removed.result).name).toBe('API CRUD editado');

    const after = await apiCall(api, 'GET', `/api/v1/projects/${project.id}`);
    expect(after.status).toBe(404);
  });

  it('inicia, reinicia, consulta logs e para', async () => {
    const { api } = await boot();
    const created = await apiCall<ProjectConfig>(
      api,
      'POST',
      '/api/v1/projects',
      fixtureProjectBody(),
    );
    const project = expectData(created.result);

    const started = await apiCall<RuntimeSnapshot>(
      api,
      'POST',
      `/api/v1/projects/${project.id}/start`,
    );
    expect(expectData(started.result).status).toBe('RUNNING');

    await waitFor(
      async () => {
        const logs = await apiCall<{ records: Array<{ text: string }> }>(
          api,
          'GET',
          `/api/v1/projects/${project.id}/logs?tail=50`,
        );
        return logs.result.success
          ? logs.result.data.records.some((record) => record.text.includes('listening on'))
          : false;
      },
      { description: 'log via HTTP' },
    );

    const restarted = await apiCall<RuntimeSnapshot>(
      api,
      'POST',
      `/api/v1/projects/${project.id}/restart`,
    );
    expect(expectData(restarted.result).status).toBe('RUNNING');

    const stopped = await apiCall<RuntimeSnapshot>(
      api,
      'POST',
      `/api/v1/projects/${project.id}/stop`,
    );
    expect(expectData(stopped.result).status).toBe('STOPPED');

    const instances = await apiCall<Array<{ id: string; status: string }>>(
      api,
      'GET',
      `/api/v1/projects/${project.id}/instances?limit=10`,
    );
    const instanceList = expectData(instances.result);
    expect(instanceList.length).toBeGreaterThanOrEqual(2);
    expect(instanceList[0]?.status).toBe('STOPPED');

    const events = await apiCall<Array<{ eventType: string }>>(
      api,
      'GET',
      `/api/v1/projects/${project.id}/events?limit=50`,
    );
    expect(
      expectData(events.result).some((event) => event.eventType === 'project.process.started'),
    ).toBe(true);
  });

  it('aceita POST sem corpo de clientes com content-type de formulário', async () => {
    const { api } = await boot();
    const created = await apiCall<ProjectConfig>(
      api,
      'POST',
      '/api/v1/projects',
      fixtureProjectBody(),
    );
    const project = expectData(created.result);

    const response = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/start`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api.token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(response.status).toBe(200);

    await apiCall(api, 'POST', `/api/v1/projects/${project.id}/stop`);
  });

  it('executa operações em lote com resultado por projeto', async () => {
    const { api } = await boot();
    const first = expectData(
      (await apiCall<ProjectConfig>(api, 'POST', '/api/v1/projects', fixtureProjectBody())).result,
    );
    const second = expectData(
      (await apiCall<ProjectConfig>(api, 'POST', '/api/v1/projects', fixtureProjectBody())).result,
    );

    const started = await apiCall<{ results: Array<{ success: boolean }> }>(
      api,
      'POST',
      '/api/v1/bulk/start',
      { projectIds: [first.id, second.id] },
    );
    const results = expectData(started.result).results;
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.success)).toBe(true);

    const stopped = await apiCall<{ results: Array<{ success: boolean }> }>(
      api,
      'POST',
      '/api/v1/bulk/stop',
      { projectIds: [first.id, second.id] },
    );
    expect(expectData(stopped.result).results.every((result) => result.success)).toBe(true);
  });

  it('detecta scripts e importa projeto sem shell', async () => {
    const { api } = await boot();
    const projectDir = createTempDir('lsm-api-project-');
    cleanups.push(async () => removeTempDir(projectDir));

    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'projeto-detectado',
        scripts: { start: 'node index.js', dev: 'vite', build: 'vite build' },
      }),
      'utf8',
    );

    const detected = await apiCall<DetectProjectResponse>(api, 'POST', '/api/v1/projects/detect', {
      directory: projectDir,
    });
    const info = expectData(detected.result);
    expect(info.hasPackageJson).toBe(true);
    expect(info.projectName).toBe('projeto-detectado');
    expect(info.scripts.map((script) => script.name)).toEqual(['build', 'dev', 'start']);
    expect(info.packageManager).toBe('npm');

    const imported = await apiCall<ProjectConfig>(api, 'POST', '/api/v1/projects/import', {
      directory: projectDir,
      script: 'dev',
    });
    expect(imported.status).toBe(201);
    const project = expectData(imported.result);
    expect(project.name).toBe('projeto-detectado');
    expect(project.runtime.executable).toBe(process.execPath);
    expect(project.runtime.args.slice(1)).toEqual(['run', 'dev']);
  });

  it('persiste configuração do Engine e rejeita keep-running', async () => {
    const { api } = await boot();

    const defaults = await apiCall<EngineSettings>(api, 'GET', '/api/v1/settings');
    expect(expectData(defaults.result).shutdownBehavior).toBe('stop-all');

    const updated = await apiCall<EngineSettings>(api, 'PUT', '/api/v1/settings', {
      batchConcurrency: 2,
    });
    expect(expectData(updated.result).batchConcurrency).toBe(2);

    const reloaded = await apiCall<EngineSettings>(api, 'GET', '/api/v1/settings');
    expect(expectData(reloaded.result).batchConcurrency).toBe(2);

    const rejected = await apiCall<EngineSettings>(api, 'PUT', '/api/v1/settings', {
      shutdownBehavior: 'keep-running',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.result.success).toBe(false);
    if (!rejected.result.success) {
      expect(rejected.result.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('API local — monitoramento', () => {
  it('expõe métricas do sistema', async () => {
    const { engine, api } = await boot();
    const created = await apiCall<ProjectConfig>(
      api,
      'POST',
      '/api/v1/projects',
      fixtureProjectBody(),
    );
    const project = expectData(created.result);
    await apiCall(api, 'POST', `/api/v1/projects/${project.id}/start`);

    await engine.metrics.collectNow();

    const metrics = await apiCall<{
      projects: Array<{ projectId: string; pid: number }>;
      system: { running: number; managedProcesses: number };
    }>(api, 'GET', '/api/v1/system/metrics');

    const data = expectData(metrics.result);
    expect(data.projects.some((item) => item.projectId === project.id && item.pid > 0)).toBe(true);
    expect(data.system.running).toBe(1);

    await apiCall(api, 'POST', `/api/v1/projects/${project.id}/stop`);
  });

  it('cria e lista backups', async () => {
    const { api } = await boot();

    const created = await apiCall<{ file: string; sizeBytes: number }>(
      api,
      'POST',
      '/api/v1/system/backup',
    );
    expect(created.status).toBe(201);
    const backup = expectData(created.result);
    expect(backup.sizeBytes).toBeGreaterThan(0);

    const list = await apiCall<Array<{ file: string }>>(api, 'GET', '/api/v1/system/backups');
    expect(expectData(list.result).some((item) => item.file === backup.file)).toBe(true);
  });

  it('gerencia grupos e exporta configurações', async () => {
    const { api } = await boot();

    const group = expectData(
      (await apiCall<ProjectGroup>(api, 'POST', '/api/v1/groups', { name: 'Backend' })).result,
    );
    const project = expectData(
      (
        await apiCall<ProjectConfig>(
          api,
          'POST',
          '/api/v1/projects',
          fixtureProjectBody({ groupId: group.id }),
        )
      ).result,
    );
    expect(project.groupId).toBe(group.id);

    const renamed = expectData(
      (
        await apiCall<ProjectGroup>(api, 'PUT', `/api/v1/groups/${group.id}`, {
          name: 'Serviços',
        })
      ).result,
    );
    expect(renamed.name).toBe('Serviços');

    const duplicate = await apiCall(api, 'POST', '/api/v1/groups', { name: 'serviços' });
    expect(duplicate.status).toBe(409);

    const exported = expectData(
      (
        await apiCall<{ projects: Array<{ name: string; group: string | null }> }>(
          api,
          'GET',
          '/api/v1/projects/export',
        )
      ).result,
    );
    expect(
      exported.projects.some((item) => item.name === project.name && item.group === 'Serviços'),
    ).toBe(true);

    expect((await apiCall(api, 'DELETE', `/api/v1/groups/${group.id}`)).status).toBe(200);

    const detail = expectData(
      (await apiCall<{ config: ProjectConfig }>(api, 'GET', `/api/v1/projects/${project.id}`))
        .result,
    );
    expect(detail.config.groupId).toBeNull();
  });

  it('exporta e importa configurações pela API', async () => {
    const { api } = await boot();
    const created = expectData(
      (
        await apiCall<ProjectConfig>(
          api,
          'POST',
          '/api/v1/projects',
          fixtureProjectBody({ name: 'Exportável' }),
        )
      ).result,
    );
    expect(created.name).toBe('Exportável');

    const bundle = expectData(
      (await apiCall<{ projects: unknown[] }>(api, 'GET', '/api/v1/projects/export')).result,
    );
    expect(bundle.projects).toHaveLength(1);

    const imported = await apiCall<{ results: Array<{ success: boolean }> }>(
      api,
      'POST',
      '/api/v1/projects/import-config',
      bundle,
    );
    expect(imported.status).toBe(200);
    expect(expectData(imported.result).results[0]?.success).toBe(false);
  });

  it('varre a raiz do repositório e propõe projetos', async () => {
    const { api } = await boot();
    const root = createTempDir('lsm-api-scan-');
    mkdirSync(join(root, 'apps', 'core'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'api-demo', private: true }),
      'utf8',
    );
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n', 'utf8');
    writeFileSync(
      join(root, 'apps', 'core', 'package.json'),
      JSON.stringify({ name: '@demo/core', scripts: { start: 'node index.js' } }),
      'utf8',
    );

    try {
      const response = await apiCall<ScanRootResponse>(api, 'POST', '/api/v1/projects/scan-root', {
        directory: root,
      });
      expect(response.status).toBe(200);
      const data = expectData(response.result);
      expect(data.isMonorepo).toBe(true);
      expect(data.projects).toHaveLength(1);
      expect(data.projects[0]?.script).toBe('start');
      expect(data.projects[0]?.relativeDirectory).toBe('apps/core');
    } finally {
      removeTempDir(root);
    }
  });

  it('gerencia túneis (CRUD)', async () => {
    const { api } = await boot();

    const created = expectData(
      (
        await apiCall<TunnelSummary>(api, 'POST', '/api/v1/tunnels', {
          name: 'túnel api',
          kind: 'quick',
          targetPort: 3_999,
        })
      ).result,
    );
    expect(created.status.state).toBe('STOPPED');
    expect(created.config.hasToken).toBe(false);

    const list = expectData((await apiCall<TunnelSummary[]>(api, 'GET', '/api/v1/tunnels')).result);
    expect(list.map((item) => item.config.name)).toContain('túnel api');

    const updated = expectData(
      (
        await apiCall<TunnelSummary>(api, 'PUT', `/api/v1/tunnels/${created.config.id}`, {
          name: 'túnel api 2',
        })
      ).result,
    );
    expect(updated.config.name).toBe('túnel api 2');

    const removed = await apiCall<{ id: string }>(
      api,
      'DELETE',
      `/api/v1/tunnels/${created.config.id}`,
    );
    expect(removed.status).toBe(200);
    expect(expectData(removed.result).id).toBe(created.config.id);
  });

  it('lista versões de Node detectadas', async () => {
    const { api } = await boot();
    const versions = expectData(
      (
        await apiCall<Array<{ executable: string; version: string }>>(
          api,
          'GET',
          '/api/v1/system/node-versions',
        )
      ).result,
    );
    expect(versions.some((item) => item.executable === process.execPath)).toBe(true);
  });

  it('consulta ocupação de porta sem matar o ocupante', async () => {
    const { api } = await boot();
    const port = await reservePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));

    try {
      const created = await apiCall<ProjectConfig>(
        api,
        'POST',
        '/api/v1/projects',
        fixtureProjectBody({ port, portSource: 'fixed' }),
      );
      const project = expectData(created.result);

      const single = await apiCall<{ port: number; inUse: boolean; ownerPid: number | null }>(
        api,
        'GET',
        `/api/v1/ports/${port}`,
      );
      expect(expectData(single.result).inUse).toBe(true);

      const list = await apiCall<Array<{ projectId: string; port: number; inUse: boolean }>>(
        api,
        'GET',
        '/api/v1/ports',
      );
      const entry = expectData(list.result).find((item) => item.projectId === project.id);
      expect(entry?.inUse).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('API local — WebSocket', () => {
  it('entrega snapshot, estado e logs ao vivo', async () => {
    const { api } = await boot();
    const created = await apiCall<ProjectConfig>(
      api,
      'POST',
      '/api/v1/projects',
      fixtureProjectBody(),
    );
    const project = expectData(created.result);

    const socket = new WebSocket(websocketUrl(api));
    const messages: WsMessage[] = [];
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)) as WsMessage);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('falha ao abrir WebSocket')));
      });

      await waitFor(() => messages.some((message) => message.type === 'project.state.changed'), {
        description: 'snapshot inicial',
      });

      const started = await apiCall<RuntimeSnapshot>(
        api,
        'POST',
        `/api/v1/projects/${project.id}/start`,
      );
      expect(expectData(started.result).status).toBe('RUNNING');

      await waitFor(
        () =>
          messages.some(
            (message) =>
              message.type === 'project.state.changed' &&
              message.payload.snapshot?.status === 'RUNNING',
          ),
        { description: 'evento de RUNNING' },
      );
      await waitFor(
        () =>
          messages.some(
            (message) =>
              message.type === 'project.log' &&
              (message.payload.text ?? '').includes('listening on'),
          ),
        { description: 'log ao vivo' },
      );
    } finally {
      socket.close();
      await apiCall(api, 'POST', `/api/v1/projects/${project.id}/stop`);
    }
  });

  it('fecha conexão com token inválido', async () => {
    const { api } = await boot();
    const socket = new WebSocket(
      `${api.baseUrl.replace('http://', 'ws://')}${api.websocketPath}?token=errado`,
    );

    const code = await new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event.code));
    });
    expect(code).toBe(1008);
  });
});
