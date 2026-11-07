import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { parseCreateProjectRequest, parseProjectConfig } from './project-config';

const base = {
  name: 'Fiscal API',
  workingDirectory: 'C:\\dev\\fiscal-api',
  runtime: { executable: 'node', args: ['server.js'] },
};

function expectCode(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Esperava erro ${code}`);
}

describe('parseCreateProjectRequest', () => {
  it('aplica defaults documentados', () => {
    const project = parseCreateProjectRequest(base);

    expect(project.description).toBeNull();
    expect(project.groupId).toBeNull();
    expect(project.enabled).toBe(true);
    expect(project.startOnBoot).toBe(false);
    expect(project.startupOrder).toBe(0);
    expect(project.environment).toEqual({});
    expect(project.port).toBeNull();
    expect(project.portSource).toBe('none');
    expect(project.restartPolicy).toEqual({
      enabled: true,
      maxRetries: 5,
      baseDelayMs: 2_000,
      maxDelayMs: 30_000,
      jitterRatio: 0,
      stableAfterMs: 60_000,
      resetRetriesAfterStable: true,
    });
    expect(project.healthCheck.enabled).toBe(false);
    expect(project.logging.maxFileSizeMb).toBe(10);
    expect(project.shutdown.gracefulTimeoutMs).toBe(10_000);
  });

  it('infere portSource=fixed quando porta é informada', () => {
    const project = parseCreateProjectRequest({ ...base, port: 3000 });
    expect(project.port).toBe(3_000);
    expect(project.portSource).toBe('fixed');
  });

  it('aceita caminho com acentos e barra invertida', () => {
    const project = parseCreateProjectRequest({
      ...base,
      workingDirectory: 'C:\\Projetos\\Ação Rápida\\api',
    });
    expect(project.workingDirectory).toContain('Ação Rápida');
  });

  it('rejeita diretório relativo', () => {
    expectCode(
      () => parseCreateProjectRequest({ ...base, workingDirectory: 'dev\\api' }),
      'VALIDATION_ERROR',
    );
  });

  it('rejeita args como string (shell disfarçado)', () => {
    expectCode(
      () =>
        parseCreateProjectRequest({
          ...base,
          runtime: { executable: 'node', args: 'server.js' },
        }),
      'VALIDATION_ERROR',
    );
  });

  it('rejeita porta fixa sem valor', () => {
    expectCode(
      () => parseCreateProjectRequest({ ...base, portSource: 'fixed' }),
      'VALIDATION_ERROR',
    );
  });

  it('rejeita nome de variável de ambiente inválido', () => {
    expectCode(
      () => parseCreateProjectRequest({ ...base, environment: { '1INVALID': 'x' } }),
      'VALIDATION_ERROR',
    );
  });

  it('rejeita chaves desconhecidas (contrato estrito)', () => {
    expectCode(() => parseCreateProjectRequest({ ...base, runInShell: true }), 'VALIDATION_ERROR');
  });

  it('exige target quando health check está habilitado', () => {
    expectCode(
      () =>
        parseCreateProjectRequest({
          ...base,
          healthCheck: { enabled: true, type: 'http' },
        }),
      'VALIDATION_ERROR',
    );
  });

  it('exige URL http(s) para health check HTTP', () => {
    expectCode(
      () =>
        parseCreateProjectRequest({
          ...base,
          healthCheck: { enabled: true, type: 'http', target: '127.0.0.1:3000' },
        }),
      'VALIDATION_ERROR',
    );
  });

  it('rejeita regex de mascaramento inválida', () => {
    expectCode(
      () => parseCreateProjectRequest({ ...base, logging: { maskPatterns: ['([a-z'] } }),
      'VALIDATION_ERROR',
    );
  });

  it('rejeita maxDelay menor que baseDelay', () => {
    expectCode(
      () =>
        parseCreateProjectRequest({
          ...base,
          restartPolicy: { baseDelayMs: 5_000, maxDelayMs: 1_000 },
        }),
      'VALIDATION_ERROR',
    );
  });
});

describe('parseProjectConfig', () => {
  it('valida configuração completa persistida', () => {
    const fields = parseCreateProjectRequest(base);
    const config = parseProjectConfig({
      ...fields,
      id: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(config.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(config.runtime.args).toEqual(['server.js']);
  });

  it('rejeita status de porta desconhecido', () => {
    const fields = parseCreateProjectRequest(base);
    expectCode(
      () =>
        parseProjectConfig({
          ...fields,
          id: 'x',
          schemaVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          portSource: 'invalido',
        }),
      'VALIDATION_ERROR',
    );
  });
});
