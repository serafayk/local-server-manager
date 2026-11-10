import { describe, expect, it } from 'vitest';
import { normalizeWebHost } from './web-hosts';

describe('normalizeWebHost', () => {
  it('aceita hostname puro', () => {
    expect(normalizeWebHost('painel.exemplo.com')).toBe('painel.exemplo.com');
  });

  it('remove esquema, caminho, porta, ponto final e caixa alta', () => {
    expect(normalizeWebHost('https://PAINEL.Exemplo.com/')).toBe('painel.exemplo.com');
    expect(normalizeWebHost('http://painel.exemplo.com:8443/ui')).toBe('painel.exemplo.com');
    expect(normalizeWebHost('painel.exemplo.com.')).toBe('painel.exemplo.com');
    expect(normalizeWebHost('painel.exemplo.com/api')).toBe('painel.exemplo.com');
  });

  it('aceita um rótulo único (ex.: hostname de máquina)', () => {
    expect(normalizeWebHost('localhost')).toBe('localhost');
    expect(normalizeWebHost('meu-pc')).toBe('meu-pc');
  });

  it('rejeita entradas inválidas', () => {
    for (const value of [
      '',
      '   ',
      'painel exemplo.com',
      'user@painel.exemplo.com',
      'https://',
      '-painel.exemplo.com',
      'painel..exemplo.com',
      'painel.exemplo.com:abc',
      null,
      42,
    ]) {
      expect(normalizeWebHost(value)).toBeNull();
    }
  });
});
