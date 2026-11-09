import { describe, expect, it } from 'vitest';
import { makeProjectConfig } from '../../../../tests/helpers/project';
import { composeDownArgs, composeUpSpec, composeConfigOf } from './command-builder';

function composeProject(overrides: Record<string, unknown> = {}) {
  return makeProjectConfig({
    kind: 'compose',
    workingDirectory: 'C:\\repo',
    compose: {
      file: 'docker-compose.yml',
      projectName: 'stack',
      dockerExecutable: null,
      ...overrides,
    },
  });
}

describe('comandos do Docker Compose', () => {
  it('resolve arquivo relativo ao diretório do projeto', () => {
    const spec = composeConfigOf(composeProject());
    expect(spec.file).toBe('C:\\repo\\docker-compose.yml');
    expect(spec.executable).toBe('docker');
    expect(spec.projectName).toBe('stack');
  });

  it('sobe anexado para o supervisor enxergar a saída', () => {
    const spec = composeUpSpec(composeProject());
    expect(spec.executable).toBe('docker');
    expect(spec.args).toEqual([
      'compose',
      '-f',
      'C:\\repo\\docker-compose.yml',
      '-p',
      'stack',
      'up',
      '--abort-on-container-exit',
      '--remove-orphans',
    ]);
    expect(spec.cwd).toBe('C:\\repo');
  });

  it('remove containers ao parar, mesmo sem projectName', () => {
    const spec = composeDownArgs(composeProject({ projectName: null }));
    expect(spec.args).toEqual([
      'compose',
      '-f',
      'C:\\repo\\docker-compose.yml',
      'down',
      '--remove-orphans',
    ]);
  });

  it('usa executável explícito do Docker quando configurado', () => {
    const spec = composeConfigOf(
      composeProject({
        dockerExecutable: 'C:\\Docker\\docker.exe',
        file: 'C:\\stack\\compose.yaml',
      }),
    );
    expect(spec.executable).toBe('C:\\Docker\\docker.exe');
    expect(spec.file).toBe('C:\\stack\\compose.yaml');
  });

  it('exige configuração de compose', () => {
    const config = {
      ...makeProjectConfig({ compose: null }),
      kind: 'compose' as const,
    };
    expect(() => composeUpSpec(config)).toThrowError(/Compose/);
  });
});
