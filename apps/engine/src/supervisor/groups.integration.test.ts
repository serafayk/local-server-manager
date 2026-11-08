import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, createTempDir, fixturePath, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

async function bootEngine(dataDir?: string): Promise<Engine> {
  const directory = dataDir ?? createTempDir('lsm-groups-');
  const engine = createEngine({ dataDir: directory, singleInstance: false, logger });
  await engine.start();
  cleanups.push(async () => {
    await engine.shutdown('test');
    removeTempDir(directory);
  });
  return engine;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

const projectBase = {
  workingDirectory: FIXTURES_DIR,
  runtime: { executable: process.execPath, args: [fixturePath('args-echo.mjs')] },
  shutdown: { gracefulTimeoutMs: 1_000 },
};

describe('Grupos e exportação/importação', () => {
  it('associa projetos a grupos e exporta sem segredos', async () => {
    const engine = await bootEngine();
    const group = engine.groups.create({ name: 'Backend' });

    const plain = engine.projects.createProject({
      name: 'API',
      ...projectBase,
      groupId: group.id,
      environment: { NODE_ENV: 'test', API_TOKEN: 'segredo' },
    });
    expect(plain.groupId).toBe(group.id);

    const bundle = engine.projects.exportConfiguration();
    const exported = bundle.projects.find((project) => project.name === 'API');
    expect(exported?.group).toBe('Backend');
    expect(exported?.environment).toEqual({ NODE_ENV: 'test' });
    expect(exported?.maskedEnvironmentKeys).toContain('API_TOKEN');
    expect(JSON.stringify(bundle)).not.toContain('segredo');
  });

  it('importa em outro Engine, recria grupo e reporta conflitos por projeto', async () => {
    const source = await bootEngine();
    const group = source.groups.create({ name: 'Backend' });
    source.projects.createProject({ name: 'API', ...projectBase, groupId: group.id });
    source.projects.createProject({ name: 'Worker', ...projectBase });
    const bundle = source.projects.exportConfiguration();

    const target = await bootEngine();
    const firstImport = target.projects.importConfiguration(bundle);
    expect(firstImport.results).toHaveLength(2);
    expect(firstImport.results.every((result) => result.success)).toBe(true);
    expect(target.groups.list().map((item) => item.name)).toContain('Backend');
    expect(
      target.projects.listProjects().find((project) => project.config.name === 'API')?.config
        .groupId,
    ).toBe(target.groups.list()[0]?.id);

    const duplicate = target.projects.importConfiguration(bundle);
    expect(
      duplicate.results.some(
        (result) => !result.success && result.errorCode === 'PROJECT_NAME_IN_USE',
      ),
    ).toBe(true);
  });

  it('rejeita bundle inválido', async () => {
    const engine = await bootEngine();
    expect(() => engine.projects.importConfiguration({ schemaVersion: 99, projects: [] })).toThrow(
      /inválido/i,
    );
  });

  it('remove grupo mantendo o projeto sem grupo', async () => {
    const engine = await bootEngine();
    const group = engine.groups.create({ name: 'Temporário' });
    const project = engine.projects.createProject({
      name: 'Sem grupo depois',
      ...projectBase,
      groupId: group.id,
    });

    engine.groups.delete(group.id);
    expect(engine.projects.getProject(project.id).groupId).toBeNull();
  });
});
