import { describe, expect, it } from 'vitest';
import { parseServiceState, postgresServiceName } from './service-manager';

describe('serviço do PostgreSQL', () => {
  it('gera nome curto e estável a partir do id', () => {
    const name = postgresServiceName('a582ca13-b9aa-4f00-8a3b-1234567890ab');
    expect(name).toBe('lsm-pg-a582ca13b9');
    expect(postgresServiceName('a582ca13-b9aa-4f00-8a3b-1234567890ab')).toBe(name);
  });

  it('interpreta sc query em português e inglês', () => {
    expect(parseServiceState('        STATE              : 4  RUNNING')).toBe('RUNNING');
    expect(parseServiceState('        ESTADO             : 4  EXECUTANDO')).toBe('RUNNING');
    expect(parseServiceState('        ESTADO             : 1  PARADO')).toBe('STOPPED');
    expect(parseServiceState('        STATE              : 2  START_PENDING')).toBe(
      'START_PENDING',
    );
    expect(parseServiceState('texto sem estado')).toBe('UNKNOWN');
  });
});
