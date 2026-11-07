import { existsSync, readFileSync } from 'node:fs';
import { createLogger, createNoopSink } from '@lsm/shared';
import { describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  createTempDir,
  fixturePath,
  removeTempDir,
  waitFor,
} from '../../../../tests/helpers';
import { createEngine } from './engine';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });

function testEngine(dataDir: string, singleInstance = false) {
  return createEngine({ dataDir, singleInstance, logger });
}

const sampleProject = {
  workingDirectory: FIXTURES_DIR,
  runtime: { executable: process.execPath, args: [fixturePath('http-server.mjs')] },
  shutdown: { gracefulTimeoutMs: 2_000 },
};

describe('Engine bootstrap', () => {
  it('grava engine.json no start e remove no shutdown', async () => {
    const dataDir = createTempDir('lsm-boot-');
    const engine = testEngine(dataDir);
    try {
      await engine.start();

      expect(existsSync(engine.paths.engineInfoFile)).toBe(true);
      const info = JSON.parse(readFileSync(engine.paths.engineInfoFile, 'utf8')) as {
        pid: number;
        protocolVersion: number;
        dataDir: string;
      };
      expect(info.pid).toBe(process.pid);
      expect(info.protocolVersion).toBe(1);
      expect(info.dataDir).toBe(engine.paths.root);

      await engine.shutdown('test');
      expect(existsSync(engine.paths.engineInfoFile)).toBe(false);
    } finally {
      removeTempDir(dataDir);
    }
  });

  it('persiste projetos entre reinícios do Engine', async () => {
    const dataDir = createTempDir('lsm-persist-');
    try {
      const first = testEngine(dataDir);
      await first.start();
      first.projects.createProject({ name: 'Persistente', ...sampleProject });
      await first.shutdown('test');

      const second = testEngine(dataDir);
      await second.start();
      const names = second.projects.listProjects().map((project) => project.config.name);
      expect(names).toContain('Persistente');
      await second.shutdown('test');
    } finally {
      removeTempDir(dataDir);
    }
  });

  it('impede dois Engines para o mesmo diretório de dados', async () => {
    const dataDir = createTempDir('lsm-single-');
    try {
      const first = createEngine({ dataDir, logger });
      await first.start();

      const second = createEngine({ dataDir, logger });
      await expect(second.start()).rejects.toMatchObject({ code: 'ENGINE_BUSY' });

      await first.shutdown('test');

      // Após liberar o lock, a segunda instância pode assumir.
      await expect(second.start()).resolves.toBeUndefined();
      expect(second.info().projects).toBe(0);
      await second.shutdown('test');
    } finally {
      removeTempDir(dataDir);
    }
  });

  it('inicia projetos marcados com startOnBoot', async () => {
    const dataDir = createTempDir('lsm-boot-projects-');
    try {
      const first = testEngine(dataDir);
      await first.start();
      const created = first.projects.createProject({
        name: 'Boot Auto',
        ...sampleProject,
        startOnBoot: true,
      });
      await first.shutdown('test');

      const second = testEngine(dataDir);
      await second.start();
      await waitFor(() => second.supervisor.getSnapshot(created.id).status === 'RUNNING', {
        timeoutMs: 10_000,
        description: 'projeto de boot em execução',
      });
      await second.shutdown('test');
      expect(existsSync(second.paths.engineInfoFile)).toBe(false);
    } finally {
      removeTempDir(dataDir);
    }
  });

  it('não inicia projetos desabilitados no boot', async () => {
    const dataDir = createTempDir('lsm-disabled-');
    try {
      const first = testEngine(dataDir);
      await first.start();
      const created = first.projects.createProject({
        name: 'Desabilitado',
        ...sampleProject,
        enabled: false,
        startOnBoot: true,
      });
      await first.shutdown('test');

      const second = testEngine(dataDir);
      await second.start();
      expect(second.supervisor.getSnapshot(created.id).status).toBe('STOPPED');
      await second.shutdown('test');
    } finally {
      removeTempDir(dataDir);
    }
  });

  it('respeita o lock quando singleInstance está desabilitado', async () => {
    const dataDir = createTempDir('lsm-nolock-');
    try {
      const first = testEngine(dataDir, false);
      const second = testEngine(dataDir, false);
      await first.start();
      await expect(second.start()).resolves.toBeUndefined();
      await first.shutdown('test');
      await second.shutdown('test');
    } finally {
      removeTempDir(dataDir);
    }
  });
});
