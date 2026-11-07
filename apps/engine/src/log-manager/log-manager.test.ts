import { readFileSync } from 'node:fs';
import type { LogRecord, ProjectConfig } from '@lsm/contracts';
import { FakeClock, createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, makeProjectConfig, removeTempDir } from '../../../../tests/helpers';
import { EventBus } from '../core/event-bus';
import { LogManager } from './log-manager';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const directories: string[] = [];

function setup(overrides: Record<string, unknown> = {}) {
  const logsDir = createTempDir('lsm-logs-');
  directories.push(logsDir);
  const clock = new FakeClock('2026-01-01T00:00:00.000Z');
  const events = new EventBus(clock, logger);
  const emitted: LogRecord[] = [];
  events.on('project.log', (event) => emitted.push(event.payload));

  const manager = new LogManager({
    logsDir,
    clock,
    logger,
    events,
    ringCapacity: 5,
    maxLineLength: 32,
  });
  const project: ProjectConfig = makeProjectConfig({
    name: 'log-project',
    logging: { maxFileSizeMb: 1, retentionDays: 1 },
    ...overrides,
  });
  manager.registerInstance(project, 'inst-1');

  return { manager, project, emitted, clock };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('LogManager', () => {
  it('monta linhas por stream e incrementa sequence', () => {
    const { manager, project } = setup();

    manager.push(project.id, 'inst-1', 'stdout', 'primeira');
    manager.push(project.id, 'inst-1', 'stdout', '\nsegunda\n');
    manager.push(project.id, 'inst-1', 'stderr', 'erro\n');

    const records = manager.tail(project.id, 'inst-1', 10);
    expect(records.map((record) => record.text)).toEqual(['primeira', 'segunda', 'erro']);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.stream)).toEqual(['stdout', 'stdout', 'stderr']);
  });

  it('respeita a capacidade do ring buffer', () => {
    const { manager, project } = setup();
    for (let index = 1; index <= 8; index += 1) {
      manager.push(project.id, 'inst-1', 'stdout', `linha-${index}\n`);
    }
    const records = manager.tail(project.id, 'inst-1', 10);
    expect(records.map((record) => record.text)).toEqual([
      'linha-4',
      'linha-5',
      'linha-6',
      'linha-7',
      'linha-8',
    ]);
  });

  it('mascara segredos antes de gravar e emitir', () => {
    const { manager, project, emitted } = setup();
    manager.push(project.id, 'inst-1', 'stdout', 'password=super-secreto\n');

    const record = manager.tail(project.id, 'inst-1', 1)[0];
    expect(record?.text).toBe('password=[REDACTED]');
    expect(emitted[0]?.text).toBe('password=[REDACTED]');
  });

  it('marca linha truncada acima do limite', () => {
    const { manager, project } = setup();
    manager.push(project.id, 'inst-1', 'stdout', `${'x'.repeat(100)}\nfim\n`);

    const records = manager.tail(project.id, 'inst-1', 10);
    expect(records[0]?.truncated).toBe(true);
    expect(records[0]?.text).toHaveLength(32);
    expect(records[1]?.text).toBe('fim');
  });

  it('grava JSONL e mantém leitura após fechar a instância', async () => {
    const { manager, project } = setup();
    manager.push(project.id, 'inst-1', 'stdout', 'ola\nmundo\n');
    manager.push(project.id, 'inst-1', 'stderr', 'falha\n');

    const filePath = manager.logFileFor(project.id, 'inst-1');
    await manager.closeInstance('inst-1');

    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { seq: number; text: string; stream: string });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ seq: 1, text: 'ola', stream: 'stdout' });
    expect(lines[2]).toMatchObject({ seq: 3, text: 'falha', stream: 'stderr' });

    // Ring buffer é limpo no close; a leitura cai para o arquivo.
    const persisted = manager.tail(project.id, 'inst-1', 10);
    expect(persisted.map((record) => record.text)).toEqual(['ola', 'mundo', 'falha']);
    expect(persisted[0]?.projectId).toBe(project.id);
    expect(persisted[0]?.instanceId).toBe('inst-1');
  });

  it('ignora chunks após o fechamento da instância', async () => {
    const { manager, project } = setup();
    manager.push(project.id, 'inst-1', 'stdout', 'antes\n');
    await manager.closeInstance('inst-1');
    manager.push(project.id, 'inst-1', 'stdout', 'depois\n');

    const records = manager.tail(project.id, 'inst-1', 10);
    expect(records.map((record) => record.text)).toEqual(['antes']);
  });

  it('não captura saída quando captureOutput é false', () => {
    const { manager, project } = setup({ logging: { captureOutput: false } });
    manager.push(project.id, 'inst-1', 'stdout', 'invisível\n');
    expect(manager.tail(project.id, 'inst-1', 10)).toHaveLength(0);
  });

  it('closeAll fecha todas as instâncias', async () => {
    const { manager, project } = setup();
    manager.push(project.id, 'inst-1', 'stdout', 'x\n');
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });
});
