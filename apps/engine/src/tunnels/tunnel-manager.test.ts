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
import {
  buildTunnelCommand,
  parseIngressHostnames,
  parseQuickTunnelUrl,
  TunnelManager,
} from './tunnel-manager';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

async function boot(): Promise<{ engine: Engine; manager: TunnelManager }> {
  const dataDir = createTempDir('lsm-tunnel-');
  const engine = createEngine({ dataDir, singleInstance: false, logger });
  await engine.start();
  const manager = new TunnelManager({
    repositories: engine.repositories,
    logManager: engine.logManager,
    processManager: engine.processManager,
    events: engine.events,
    clock: engine.clock,
    logger,
    buildCommand: () => ({
      executable: process.execPath,
      args: [fixturePath('fake-tunnel.mjs')],
      cwd: FIXTURES_DIR,
      env: {},
    }),
    probeReady: async () => true,
  });
  manager.initialize();
  cleanups.push(async () => {
    await manager.shutdown();
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return { engine, manager };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe('parseIngressHostnames', () => {
  it('extrai hostname/service do bloco ingress', () => {
    const yaml = [
      'tunnel: abc',
      'credentials-file: C:/x/abc.json',
      'ingress:',
      '  - hostname: app.example.com',
      '    service: http://localhost:3000',
      '    originRequest:',
      '        httpHostHeader: app.example.com',
      '    ',
      '  - hostname: "api.example.com"',
      '    service: http://localhost:3010',
      '',
      '#  - hostname: ignored.example.com',
      '#    service: http://localhost:9999',
      '',
      '  - hostname: third.example.com',
      '    service: http://localhost:3011',
      '  - service: http_status:404',
    ].join('\n');
    expect(parseIngressHostnames(yaml)).toEqual([
      { hostname: 'app.example.com', service: 'http://localhost:3000' },
      { hostname: 'api.example.com', service: 'http://localhost:3010' },
      { hostname: 'third.example.com', service: 'http://localhost:3011' },
    ]);
  });

  it('ignora comentários e retorna vazio sem ingress', () => {
    expect(parseIngressHostnames('tunnel: abc\n# ingress:\n')).toEqual([]);
    expect(parseIngressHostnames('')).toEqual([]);
  });
});

describe('parseQuickTunnelUrl', () => {
  it('captura a URL trycloudflare', () => {
    const output =
      'INF +--------------------------------------------------------------------------------------------+\n' +
      'INF |  https://fake-test.trycloudflare.com                                                        |\n';
    expect(parseQuickTunnelUrl(output)).toBe('https://fake-test.trycloudflare.com');
    expect(parseQuickTunnelUrl('sem url')).toBeNull();
  });
});

describe('buildTunnelCommand', () => {
  const base = {
    id: 't1',
    name: 'teste',
    enabled: true,
    startOnBoot: false,
    projectId: null,
    hasToken: false,
    metricsPort: 20_241,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('config usa --config e --metrics antes de run', () => {
    const command = buildTunnelCommand(
      { ...base, kind: 'config', configPath: 'C:\\x\\config.yml', targetPort: null },
      null,
    );
    expect(command.args).toEqual([
      'tunnel',
      '--config',
      'C:\\x\\config.yml',
      '--metrics',
      '127.0.0.1:20241',
      'run',
    ]);
  });

  it('token vai por variável de ambiente, nunca em argv', () => {
    const command = buildTunnelCommand(
      { ...base, kind: 'token', configPath: null, targetPort: null },
      'segredo',
    );
    expect(command.args).not.toContain('segredo');
    expect(command.env.TUNNEL_TOKEN).toBe('segredo');
  });

  it('quick aponta para a porta alvo', () => {
    const command = buildTunnelCommand(
      { ...base, kind: 'quick', configPath: null, targetPort: 3_001 },
      null,
    );
    expect(command.args).toContain('http://127.0.0.1:3001');
    expect(command.args).toContain('--no-autoupdate');
  });
});

describe('TunnelManager', () => {
  it('cria, inicia quick tunnel, captura URL, grava log e para', async () => {
    const { manager } = await boot();
    const created = manager.create({
      name: 'quick teste',
      kind: 'quick',
      targetPort: 3_001,
    });

    expect(created.config.kind).toBe('quick');
    expect(created.config.metricsPort).toBe(20_241);

    await manager.start(created.config.id);
    await waitFor(() => manager.get(created.config.id).status.url !== null, {
      timeoutMs: 5_000,
      description: 'URL do quick tunnel',
    });

    const status = manager.get(created.config.id).status;
    expect(status.state).toBe('RUNNING');
    expect(status.url).toBe('https://fake-test.trycloudflare.com');
    expect(status.pid).toBeGreaterThan(0);

    const logs = manager.logs(created.config.id, 50);
    expect(logs.some((record) => record.text.includes('trycloudflare.com'))).toBe(true);

    await manager.stop(created.config.id);
    expect(manager.get(created.config.id).status.state).toBe('STOPPED');
  });

  it('recusa nome duplicado e edição com túnel ativo', async () => {
    const { manager } = await boot();
    manager.create({ name: 'duplicado', kind: 'quick', targetPort: 3_002 });
    expect(() => manager.create({ name: 'duplicado', kind: 'quick', targetPort: 3_003 })).toThrow(
      /já existe/i,
    );

    const created = manager.create({ name: 'ativo', kind: 'quick', targetPort: 3_004 });
    await manager.start(created.config.id);
    expect(() => manager.update(created.config.id, { name: 'novo' })).toThrow(/pare o túnel/i);
    await manager.stop(created.config.id);
    const updated = manager.update(created.config.id, { name: 'novo' });
    expect(updated.config.name).toBe('novo');
  });

  it('valida quick sem porta e config inexistente', async () => {
    const { manager } = await boot();
    expect(() => manager.create({ name: 'sem porta', kind: 'quick' })).toThrow(/porta alvo/i);
    expect(() =>
      manager.create({
        name: 'config ruim',
        kind: 'config',
        configPath: 'C:\\nao-existe\\config.yml',
      }),
    ).toThrow(/não encontrado/i);
  });

  it('remove túnel parado', async () => {
    const { manager } = await boot();
    const created = manager.create({ name: 'descartável', kind: 'quick', targetPort: 3_005 });
    expect(manager.remove(created.config.id).name).toBe('descartável');
    expect(() => manager.get(created.config.id)).toThrow(/não encontrado/i);
  });
});
