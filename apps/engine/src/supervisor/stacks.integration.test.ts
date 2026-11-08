import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import { createEngine, type Engine } from '../bootstrap/engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const cleanups: Array<() => Promise<void>> = [];

function appDirectory(prefix: string): string {
  const directory = createTempDir(prefix);
  writeFileSync(join(directory, 'app.mjs'), 'setInterval(() => {}, 1000);\n', 'utf8');
  cleanups.push(async () => removeTempDir(directory));
  return directory;
}

async function bootEngine(): Promise<Engine> {
  const dataDir = createTempDir('lsm-stacks-');
  const engine = createEngine({ dataDir, singleInstance: false, logger });
  await engine.start();
  cleanups.push(async () => {
    await engine.shutdown('test');
    removeTempDir(dataDir);
  });
  return engine;
}

afterEach(async () => {
  // Ordem de registro: Engine antes das pastas, para parar processos primeiro.
  while (cleanups.length > 0) {
    const cleanup = cleanups.shift();
    if (cleanup) {
      await cleanup();
    }
  }
});

function runtimeFor(directory: string) {
  return { executable: process.execPath, args: [join(directory, 'app.mjs')] };
}

describe('stacks com dependências', () => {
  it('sobe na ordem, aguarda a dependência e para na ordem inversa', async () => {
    const engine = await bootEngine();
    const directory = appDirectory('lsm-stack-order-');
    const group = engine.groups.create({ name: 'App' });

    const db = engine.projects.createProject({
      name: 'db',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      groupId: group.id,
      shutdown: { gracefulTimeoutMs: 1_000 },
    });
    const api = engine.projects.createProject({
      name: 'api',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      groupId: group.id,
      dependsOn: [{ projectId: db.id, waitFor: 'ready' }],
      dependencyTimeoutMs: 10_000,
      shutdown: { gracefulTimeoutMs: 1_000 },
    });
    const web = engine.projects.createProject({
      name: 'web',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      groupId: group.id,
      dependsOn: [{ projectId: api.id, waitFor: 'started' }],
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    const started = await engine.stacks.startGroup(group.id);
    expect(started.levels).toEqual([[db.id], [api.id], [web.id]]);
    expect(started.results.every((result) => result.success)).toBe(true);
    for (const id of [db.id, api.id, web.id]) {
      expect(engine.supervisor.getSnapshot(id).status).toBe('RUNNING');
    }

    const stopped = await engine.stacks.stopGroup(group.id);
    expect(stopped.levels).toEqual([[web.id], [api.id], [db.id]]);
    for (const id of [db.id, api.id, web.id]) {
      expect(engine.supervisor.getSnapshot(id).status).toBe('STOPPED');
    }
  }, 30_000);

  it('não inicia dependentes quando a dependência falha', async () => {
    const engine = await bootEngine();
    const directory = appDirectory('lsm-stack-fail-');
    const group = engine.groups.create({ name: 'Quebrada' });

    const broken = engine.projects.createProject({
      name: 'quebrado',
      workingDirectory: join(directory, 'nao-existe'),
      runtime: runtimeFor(directory),
      groupId: group.id,
      shutdown: { gracefulTimeoutMs: 1_000 },
    });
    const dependent = engine.projects.createProject({
      name: 'dependente',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      groupId: group.id,
      dependsOn: [{ projectId: broken.id, waitFor: 'started' }],
      dependencyTimeoutMs: 2_000,
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    const result = await engine.stacks.startGroup(group.id);

    const brokenResult = result.results.find((item) => item.projectId === broken.id);
    const dependentResult = result.results.find((item) => item.projectId === dependent.id);
    expect(brokenResult?.success).toBe(false);
    expect(dependentResult).toMatchObject({
      success: false,
      errorCode: 'DEPENDENCY_FAILED',
    });
    expect(result.skipped.map((item) => item.projectId)).toContain(dependent.id);
    expect(engine.supervisor.getSnapshot(dependent.id).status).not.toBe('RUNNING');
  }, 30_000);

  it('sobe dependência fora do grupo e não a para junto', async () => {
    const engine = await bootEngine();
    const directory = appDirectory('lsm-stack-external-');
    const infra = engine.groups.create({ name: 'Infra' });
    const app = engine.groups.create({ name: 'App' });

    const db = engine.projects.createProject({
      name: 'db-externa',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      groupId: infra.id,
      shutdown: { gracefulTimeoutMs: 1_000 },
    });
    engine.projects.createProject({
      name: 'api-externa',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      groupId: app.id,
      dependsOn: [{ projectId: db.id, waitFor: 'ready' }],
      dependencyTimeoutMs: 10_000,
      shutdown: { gracefulTimeoutMs: 1_000 },
    });

    const started = await engine.stacks.startGroup(app.id);
    expect(started.results).toHaveLength(2);
    expect(engine.supervisor.getSnapshot(db.id).status).toBe('RUNNING');

    await engine.stacks.stopGroup(app.id);
    // Parar o grupo da app não derruba a infraestrutura compartilhada.
    expect(engine.supervisor.getSnapshot(db.id).status).toBe('RUNNING');
  }, 30_000);

  it('rejeita ciclo na configuração e protege a remoção de dependência', async () => {
    const engine = await bootEngine();
    const directory = appDirectory('lsm-stack-cycle-');

    const a = engine.projects.createProject({
      name: 'a',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
    });
    const b = engine.projects.createProject({
      name: 'b',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
    });

    engine.projects.updateProject(a.id, { dependsOn: [{ projectId: b.id, waitFor: 'started' }] });
    expect(() =>
      engine.projects.updateProject(b.id, {
        dependsOn: [{ projectId: a.id, waitFor: 'started' }],
      }),
    ).toThrowError(/ciclo/i);

    expect(() => engine.projects.deleteProject(b.id)).toThrowError(/dependência de/i);
    engine.projects.deleteProject(b.id, { force: true });
    expect(engine.projects.getProject(a.id).dependsOn).toEqual([]);
  }, 20_000);

  it('exporta dependências por nome e reconecta na importação', async () => {
    const source = await bootEngine();
    const directory = appDirectory('lsm-stack-export-');

    const db = source.projects.createProject({
      name: 'db-export',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
    });
    source.projects.createProject({
      name: 'api-export',
      workingDirectory: directory,
      runtime: runtimeFor(directory),
      dependsOn: [{ projectId: db.id, waitFor: 'ready' }],
      dependencyTimeoutMs: 90_000,
    });

    const bundle = source.projects.exportConfiguration();
    const exported = bundle.projects.find((project) => project.name === 'api-export');
    expect(exported?.dependsOn).toEqual([{ project: 'db-export', waitFor: 'ready' }]);
    expect(exported?.dependencyTimeoutMs).toBe(90_000);

    const target = await bootEngine();
    const imported = target.projects.importConfiguration(bundle);
    expect(imported.results.every((result) => result.success)).toBe(true);

    const api = target.projects.getProject('api-export');
    const importedDb = target.projects.getProject('db-export');
    expect(api.dependsOn).toEqual([{ projectId: importedDb.id, waitFor: 'ready' }]);
    expect(api.dependencyTimeoutMs).toBe(90_000);
  }, 20_000);
});
