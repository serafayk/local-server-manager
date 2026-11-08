import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, createNoopSink } from '@lsm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../../../tests/helpers';
import {
  extractManagedHosts,
  HostsManager,
  MANAGED_BEGIN,
  MANAGED_END,
  pendingHosts,
  renderHostsWithBlock,
} from './hosts-file';

const logger = createLogger({ level: 'error', sinks: [createNoopSink()] });
const directories: string[] = [];

function tempHosts(content = ''): string {
  const directory = createTempDir('lsm-hosts-');
  directories.push(directory);
  const file = join(directory, 'hosts');
  writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTempDir(directory);
  }
});

describe('arquivo hosts', () => {
  it('lê apenas os hosts do bloco gerenciado', () => {
    const content = [
      '127.0.0.1 localhost',
      MANAGED_BEGIN,
      '127.0.0.1 api.uai.lsm',
      '127.0.0.1 web.uai.lsm',
      MANAGED_END,
      '10.0.0.1 outro',
    ].join('\r\n');

    expect(extractManagedHosts(content)).toEqual(['api.uai.lsm', 'web.uai.lsm']);
  });

  it('preserva o conteúdo existente e é idempotente', () => {
    const original = '127.0.0.1 localhost\r\n# comentário\r\n';
    const first = renderHostsWithBlock(original, ['web.uai.lsm', 'api.uai.lsm']);
    const second = renderHostsWithBlock(first, ['api.uai.lsm', 'web.uai.lsm']);

    expect(first).toContain('127.0.0.1 localhost');
    expect(first).toContain('# comentário');
    expect(second).toBe(first);
    expect(first.indexOf('api.uai.lsm')).toBeLessThan(first.indexOf('web.uai.lsm'));
    expect(first).toContain(MANAGED_BEGIN);
    expect(first).toContain(MANAGED_END);
  });

  it('remove o bloco quando a lista fica vazia', () => {
    const withBlock = renderHostsWithBlock('127.0.0.1 localhost\r\n', ['api.uai.lsm']);
    const without = renderHostsWithBlock(withBlock, []);
    expect(without).not.toContain(MANAGED_BEGIN);
    expect(without).not.toContain('api.uai.lsm');
    expect(without).toContain('127.0.0.1 localhost');
  });

  it('calcula hosts pendentes', () => {
    const content = renderHostsWithBlock('', ['api.uai.lsm']);
    expect(pendingHosts(content, ['api.uai.lsm', 'web.uai.lsm'])).toEqual(['web.uai.lsm']);
    expect(pendingHosts(content, ['api.uai.lsm'])).toEqual([]);
  });

  it('não chama o processo elevado quando já está sincronizado', async () => {
    const file = tempHosts(renderHostsWithBlock('127.0.0.1 localhost\r\n', ['api.uai.lsm']));
    let calls = 0;
    const manager = new HostsManager({
      logger,
      filePath: file,
      runElevated: async () => {
        calls += 1;
        return { code: 0, stderr: '' };
      },
    });

    const result = await manager.sync(['api.uai.lsm']);
    expect(result).toMatchObject({ ok: true, applied: [], error: null });
    expect(calls).toBe(0);
  });

  it('aplica o bloco via runner elevado e confirma o resultado', async () => {
    const file = tempHosts('127.0.0.1 localhost\r\n');
    let captured = '';
    const manager = new HostsManager({
      logger,
      filePath: file,
      runElevated: async (content) => {
        captured = content;
        writeFileSync(file, content, 'utf8');
        return { code: 0, stderr: '' };
      },
    });

    const result = await manager.sync(['api.uai.lsm', 'web.uai.lsm']);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual(['api.uai.lsm', 'web.uai.lsm']);
    expect(captured).toContain('127.0.0.1 api.uai.lsm');
    expect(readFileSync(file, 'utf8')).toContain('127.0.0.1 web.uai.lsm');
  });

  it('reporta falha quando o UAC é cancelado', async () => {
    const file = tempHosts('127.0.0.1 localhost\r\n');
    const manager = new HostsManager({
      logger,
      filePath: file,
      runElevated: async () => ({ code: 1, stderr: 'cancelado' }),
    });

    const result = await manager.sync(['api.uai.lsm']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cancelado');
    expect(result.pending).toEqual(['api.uai.lsm']);
  });
});
