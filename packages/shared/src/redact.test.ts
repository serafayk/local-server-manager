import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redactText, redactValue } from './redact';

describe('redactValue', () => {
  it('mascara chaves sensíveis em qualquer profundidade', () => {
    const value = {
      name: 'api',
      password: 'segredo',
      nested: { token: 'abc', authorization: 'Bearer xyz', port: 3000 },
      list: [{ apiKey: 'k' }],
    };
    expect(redactValue(value)).toEqual({
      name: 'api',
      password: '[REDACTED]',
      nested: { token: '[REDACTED]', authorization: '[REDACTED]', port: 3000 },
      list: [{ apiKey: '[REDACTED]' }],
    });
  });

  it('reconhece variações de nome de chave', () => {
    expect(isSensitiveKey('DB_PASSWORD')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
    expect(isSensitiveKey('api-key')).toBe(true);
    expect(isSensitiveKey('port')).toBe(false);
  });
});

describe('redactText', () => {
  it('mascara pares chave=valor comuns', () => {
    expect(redactText('password=abc123 next')).toContain('password=[REDACTED]');
    expect(redactText('token: "xyz"')).toContain('token=[REDACTED]');
    expect(redactText('Authorization: Bearer abc.def')).toContain('Authorization=[REDACTED]');
  });

  it('aceita padrões adicionais e ignora padrões inválidos', () => {
    expect(redactText('cpf=12345678900', ['cpf=\\d+'])).toContain('cpf=[REDACTED]');
    expect(redactText('texto normal', ['([a-z'])).toBe('texto normal');
  });

  it('não altera texto sem segredos', () => {
    expect(redactText('listening on 3000')).toBe('listening on 3000');
  });
});
