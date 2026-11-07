import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@lsm/contracts';
import { AppError, newId } from '@lsm/shared';
import { parseCreateProjectRequest } from '@lsm/validation';
import { openInMemoryDatabase } from './connection';
import { migrate } from './migrator';
import { createRepositories, type Repositories } from './repositories';

function setup(): { repositories: Repositories; close: () => void } {
  const db = openInMemoryDatabase();
  migrate(db.connection);
  return { repositories: createRepositories(db.connection), close: () => db.close() };
}

function makeProject(overrides: Record<string, unknown> = {}): ProjectConfig {
  const fields = parseCreateProjectRequest({
    name: 'Projeto',
    workingDirectory: 'C:\\dev\\projeto',
    runtime: { executable: 'node', args: ['index.js'] },
    ...overrides,
  });
  return {
    id: newId(),
    ...fields,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SqliteProjectRepository', () => {
  it('faz roundtrip completo de configuração', () => {
    const { repositories, close } = setup();
    const project = makeProject({
      name: 'Fiscal API',
      description: 'API local',
      port: 3000,
      environment: { NODE_ENV: 'development' },
      startOnBoot: true,
      startupOrder: 2,
      restartPolicy: { maxRetries: 9 },
      healthCheck: {
        enabled: true,
        type: 'http',
        target: 'http://127.0.0.1:3000/health',
      },
    });

    repositories.projects.create(project);
    const loaded = repositories.projects.findById(project.id);

    expect(loaded).toEqual(project);
    expect(loaded?.restartPolicy.maxRetries).toBe(9);
    expect(loaded?.healthCheck.target).toBe('http://127.0.0.1:3000/health');
    close();
  });

  it('busca por nome sem diferenciar maiúsculas', () => {
    const { repositories, close } = setup();
    const project = makeProject({ name: 'Minha API' });
    repositories.projects.create(project);

    expect(repositories.projects.findByName('minha api')?.id).toBe(project.id);
    close();
  });

  it('rejeita nome duplicado com código estável', () => {
    const { repositories, close } = setup();
    repositories.projects.create(makeProject({ name: 'Duplicado' }));

    try {
      repositories.projects.create(makeProject({ name: 'duplicado' }));
      throw new Error('esperava PROJECT_NAME_IN_USE');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PROJECT_NAME_IN_USE');
    }
    close();
  });

  it('atualiza configuração e políticas', () => {
    const { repositories, close } = setup();
    const project = makeProject({ name: 'Original' });
    repositories.projects.create(project);

    const updated: ProjectConfig = {
      ...project,
      name: 'Renomeado',
      port: 4000,
      portSource: 'fixed',
      restartPolicy: { ...project.restartPolicy, enabled: false, maxRetries: 1 },
      updatedAt: '2026-02-01T00:00:00.000Z',
    };
    repositories.projects.update(updated);

    const loaded = repositories.projects.findById(project.id);
    expect(loaded?.name).toBe('Renomeado');
    expect(loaded?.port).toBe(4_000);
    expect(loaded?.restartPolicy.enabled).toBe(false);
    expect(loaded?.restartPolicy.maxRetries).toBe(1);
    close();
  });

  it('ordena por startupOrder e filtra projetos de boot', () => {
    const { repositories, close } = setup();
    repositories.projects.create(
      makeProject({ name: 'Terceiro', startupOrder: 30, startOnBoot: true }),
    );
    repositories.projects.create(
      makeProject({ name: 'Primeiro', startupOrder: 10, startOnBoot: false }),
    );
    repositories.projects.create(
      makeProject({ name: 'Segundo', startupOrder: 20, startOnBoot: true }),
    );

    expect(repositories.projects.list().map((project) => project.name)).toEqual([
      'Primeiro',
      'Segundo',
      'Terceiro',
    ]);
    expect(repositories.projects.listBootProjects().map((project) => project.name)).toEqual([
      'Segundo',
      'Terceiro',
    ]);
    close();
  });

  it('remove configuração, políticas e instâncias em cascata', () => {
    const { repositories, close } = setup();
    const project = makeProject();
    repositories.projects.create(project);
    repositories.instances.create({
      id: 'instancia-1',
      projectId: project.id,
      status: 'STOPPED',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(repositories.projects.delete(project.id)).toBe(true);
    expect(repositories.projects.findById(project.id)).toBeNull();
    expect(repositories.instances.listByProject(project.id)).toHaveLength(0);
    expect(repositories.projects.delete(project.id)).toBe(false);
    close();
  });
});

describe('SqliteInstanceRepository', () => {
  it('registra ciclo de vida da instância', () => {
    const { repositories, close } = setup();
    const project = makeProject();
    repositories.projects.create(project);

    repositories.instances.create({
      id: 'i-1',
      projectId: project.id,
      status: 'STARTING',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(repositories.instances.listUnfinished()).toHaveLength(1);

    repositories.instances.markRunning({
      id: 'i-1',
      pid: 4242,
      pidStartedAt: '2026-01-01T00:00:02.000Z',
      startedAt: '2026-01-01T00:00:02.000Z',
    });
    repositories.instances.finish({
      id: 'i-1',
      endedAt: '2026-01-01T00:01:00.000Z',
      exitCode: 0,
      exitSignal: null,
      terminationReason: 'STOP_MANUAL',
      status: 'STOPPED',
    });

    const instance = repositories.instances.findById('i-1');
    expect(instance?.pid).toBe(4_242);
    expect(instance?.pidStartedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(instance?.terminationReason).toBe('STOP_MANUAL');
    expect(repositories.instances.listUnfinished()).toHaveLength(0);
    close();
  });
});

describe('SqliteEventRepository', () => {
  it('grava e filtra eventos', () => {
    const { repositories, close } = setup();
    repositories.events.append({
      projectId: 'p1',
      instanceId: null,
      level: 'info',
      eventType: 'project.created',
      message: 'criado',
      metadata: { name: 'P1' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    repositories.events.append({
      projectId: 'p1',
      instanceId: 'i1',
      level: 'error',
      eventType: 'project.crashed',
      message: 'crash',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    repositories.events.append({
      projectId: 'p2',
      instanceId: null,
      level: 'info',
      eventType: 'project.created',
      message: 'criado',
      createdAt: '2026-01-01T00:00:02.000Z',
    });

    expect(repositories.events.count()).toBe(3);
    expect(repositories.events.list({ projectId: 'p1' })).toHaveLength(2);
    expect(repositories.events.list({ level: 'error' })).toHaveLength(1);
    expect(repositories.events.list({ eventType: 'project.created' })).toHaveLength(2);
    expect(repositories.events.list({ limit: 1 })).toHaveLength(1);
    close();
  });

  it('remove eventos antigos', () => {
    const { repositories, close } = setup();
    repositories.events.append({
      projectId: null,
      instanceId: null,
      level: 'info',
      eventType: 'engine.ready',
      message: 'antigo',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    repositories.events.append({
      projectId: null,
      instanceId: null,
      level: 'info',
      eventType: 'engine.ready',
      message: 'novo',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(repositories.events.deleteOlderThan('2025-06-01T00:00:00.000Z')).toBe(1);
    expect(repositories.events.count()).toBe(1);
    close();
  });
});

describe('SqliteSettingsRepository', () => {
  it('grava, lê e remove configurações', () => {
    const { repositories, close } = setup();
    repositories.settings.set('engine', { logLevel: 'debug' });

    expect(repositories.settings.get('engine')).toEqual({ logLevel: 'debug' });
    expect(repositories.settings.get('inexistente')).toBeNull();
    expect(repositories.settings.all()).toEqual({ engine: { logLevel: 'debug' } });
    expect(repositories.settings.delete('engine')).toBe(true);
    expect(repositories.settings.get('engine')).toBeNull();
    close();
  });
});
