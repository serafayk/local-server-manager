import { describe, expect, it } from 'vitest';
import {
  applyMemoryProfile,
  buildCreateBody,
  buildImportBody,
  emptyFormState,
  formStateFromConfig,
  memoryProfileFromState,
  parseArgsText,
  validateAdvanced,
  validateCommand,
  validateFormState,
  validateStep,
} from './payload';
import { makeProjectConfig } from '../../../../tests/helpers/project';

function validState() {
  return {
    ...emptyFormState(),
    name: 'API',
    directory: 'C:\\dev\\api',
    executable: 'node',
    argsText: 'server.js\n--port\n3000',
  };
}

describe('parseArgsText', () => {
  it('usa uma linha por argumento e ignora vazias', () => {
    expect(parseArgsText('server.js\n\n--flag com espaço\r\n')).toEqual([
      'server.js',
      '--flag com espaço',
    ]);
  });
});

describe('buildCreateBody', () => {
  it('monta payload completo', () => {
    const state = {
      ...validState(),
      port: '3000',
      environment: [{ key: 'NODE_ENV', value: 'development' }],
      startOnBoot: true,
      maxRetries: '3',
    };
    const body = buildCreateBody(state) as {
      name: string;
      port: number;
      portSource: string;
      environment: Record<string, string>;
      startOnBoot: boolean;
      runtime: { executable: string; args: string[] };
      restartPolicy: { maxRetries: number; enabled: boolean };
    };

    expect(body.name).toBe('API');
    expect(body.port).toBe(3_000);
    expect(body.portSource).toBe('fixed');
    expect(body.environment).toEqual({ NODE_ENV: 'development' });
    expect(body.startOnBoot).toBe(true);
    expect(body.runtime).toEqual({ executable: 'node', args: ['server.js', '--port', '3000'] });
    expect(body.restartPolicy.maxRetries).toBe(3);
    expect(body.restartPolicy.enabled).toBe(true);
  });

  it('omite porta quando vazia', () => {
    const body = buildCreateBody(validState()) as { port: number | null; portSource: string };
    expect(body.port).toBeNull();
    expect(body.portSource).toBe('none');
  });

  it('inclui grupo no payload', () => {
    const body = buildCreateBody({ ...validState(), groupId: 'grupo-1' }) as {
      groupId: string | null;
    };
    expect(body.groupId).toBe('grupo-1');
  });
});

describe('perfis de memória (NODE_OPTIONS)', () => {
  it('aplica um preset e detecta de volta', () => {
    const state = applyMemoryProfile(validState(), 'low');
    expect(state.environment).toContainEqual({
      key: 'NODE_OPTIONS',
      value: '--max-old-space-size=256 --max-semi-space-size=8',
    });

    const detected = memoryProfileFromState(state);
    expect(detected.profile).toBe('low');
    expect(detected.heapMb).toBe(256);
    expect(detected.semiSpaceMb).toBe(8);
  });

  it('preserva variáveis existentes ao trocar o perfil', () => {
    const withEnv = { ...validState(), environment: [{ key: 'NODE_ENV', value: 'production' }] };
    const state = applyMemoryProfile(withEnv, 'medium');
    expect(state.environment).toHaveLength(2);
    expect(state.environment).toContainEqual({ key: 'NODE_ENV', value: 'production' });
  });

  it('desliga removendo apenas NODE_OPTIONS', () => {
    const withEnv = {
      ...validState(),
      environment: [
        { key: 'NODE_OPTIONS', value: '--max-old-space-size=512' },
        { key: 'NODE_ENV', value: 'production' },
      ],
    };
    const state = applyMemoryProfile(withEnv, 'off');
    expect(state.environment).toEqual([{ key: 'NODE_ENV', value: 'production' }]);
  });

  it('trata valor manual como personalizado', () => {
    const manual = {
      ...validState(),
      environment: [{ key: 'NODE_OPTIONS', value: '--max-old-space-size=300' }],
    };
    const detected = memoryProfileFromState(manual);
    expect(detected.profile).toBe('custom');
    expect(detected.heapMb).toBe(300);

    const applied = applyMemoryProfile(manual, 'custom', { heapMb: 400, semiSpaceMb: 4 });
    expect(applied.environment).toContainEqual({
      key: 'NODE_OPTIONS',
      value: '--max-old-space-size=400 --max-semi-space-size=4',
    });
  });
});

describe('buildImportBody', () => {
  it('envia script e package manager sem runtime', () => {
    const state = {
      ...validState(),
      mode: 'script' as const,
      packageManager: 'pnpm' as const,
      script: 'dev',
    };
    const body = buildImportBody(state) as Record<string, unknown>;
    expect(body.script).toBe('dev');
    expect(body.packageManager).toBe('pnpm');
    expect(body.runtime).toBeUndefined();
  });
});

describe('validação', () => {
  it('exige nome e diretório absoluto na primeira etapa', () => {
    const problems = validateStep(emptyFormState(), 0);
    expect(problems).toContain('Informe um nome para o projeto.');
    expect(problems.some((message) => message.includes('caminho absoluto'))).toBe(true);
  });

  it('aceita estado válido', () => {
    expect(validateFormState(validState())).toEqual([]);
  });

  it('valida porta e script na segunda etapa', () => {
    expect(validateCommand({ ...validState(), port: '70000' })).toContain(
      'A porta deve estar entre 1 e 65535.',
    );
    expect(
      validateCommand({ ...validState(), mode: 'script', script: 'invalido script' }),
    ).toContain('Informe um script válido do package.json.');
  });

  it('valida políticas e health check na terceira etapa', () => {
    expect(
      validateAdvanced({
        ...validState(),
        baseDelayMs: '5000',
        maxDelayMs: '1000',
      }),
    ).toContain('maxDelayMs deve ser >= baseDelayMs.');

    const health = validateAdvanced({
      ...validState(),
      healthEnabled: true,
      healthType: 'http',
      healthTarget: '127.0.0.1:3000',
    });
    expect(health.some((message) => message.includes('http://'))).toBe(true);

    const timeout = validateAdvanced({
      ...validState(),
      healthEnabled: true,
      healthType: 'http',
      healthTarget: 'http://127.0.0.1:3000/health',
      healthIntervalMs: '1000',
      healthTimeoutMs: '5000',
    });
    expect(timeout.some((message) => message.includes('menor ou igual'))).toBe(true);
  });

  it('detecta variáveis inválidas e duplicadas', () => {
    const problems = validateCommand({
      ...validState(),
      environment: [
        { key: '1INVALID', value: 'x' },
        { key: 'DUP', value: 'a' },
        { key: 'DUP', value: 'b' },
      ],
    });
    expect(problems.some((message) => message.includes('1INVALID'))).toBe(true);
    expect(problems.some((message) => message.includes('duplicada'))).toBe(true);
  });
});

describe('formStateFromConfig', () => {
  it('faz roundtrip da configuração para o formulário', () => {
    const config = makeProjectConfig({
      name: 'Roundtrip',
      workingDirectory: 'C:\\dev\\roundtrip',
      port: 4321,
      environment: { NODE_ENV: 'test' },
      startOnBoot: true,
      restartPolicy: { maxRetries: 7 },
    });
    const state = formStateFromConfig(config);

    expect(state.name).toBe('Roundtrip');
    expect(state.directory).toBe('C:\\dev\\roundtrip');
    expect(state.port).toBe('4321');
    expect(state.environment).toEqual([{ key: 'NODE_ENV', value: 'test' }]);
    expect(state.startOnBoot).toBe(true);
    expect(state.maxRetries).toBe('7');
    expect(state.mode).toBe('custom');
  });

  it('preserva o grupo no roundtrip', () => {
    const config = makeProjectConfig({ name: 'Com grupo', groupId: 'grupo-1' });
    expect(formStateFromConfig(config).groupId).toBe('grupo-1');
  });
});
