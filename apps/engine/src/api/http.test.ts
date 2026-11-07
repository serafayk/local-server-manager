import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import { isAllowedHostHeader, isAllowedOrigin, parsePositiveInt } from './http';

describe('isAllowedHostHeader', () => {
  it('aceita loopback na porta correta', () => {
    expect(isAllowedHostHeader('127.0.0.1:3000', 3000)).toBe(true);
    expect(isAllowedHostHeader('localhost:3000', 3000)).toBe(true);
    expect(isAllowedHostHeader('[::1]:3000', 3000)).toBe(true);
  });

  it('rejeita host externo, porta errada e formatos inválidos', () => {
    expect(isAllowedHostHeader('evil.com:3000', 3000)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:4000', 3000)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1', 3000)).toBe(false);
    expect(isAllowedHostHeader(undefined, 3000)).toBe(false);
    expect(isAllowedHostHeader(123, 3000)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['http://localhost:1420', 'tauri://localhost'];

  it('permite ausência de Origin (clientes não-browser)', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it('permite apenas origens da allowlist', () => {
    expect(isAllowedOrigin('http://localhost:1420', allowed)).toBe(true);
    expect(isAllowedOrigin('tauri://localhost', allowed)).toBe(true);
    expect(isAllowedOrigin('http://evil.com', allowed)).toBe(false);
    expect(isAllowedOrigin(42, allowed)).toBe(false);
  });
});

describe('parsePositiveInt', () => {
  it('usa fallback e limita ao intervalo', () => {
    expect(parsePositiveInt(undefined, 50, 1, 100)).toBe(50);
    expect(parsePositiveInt('10', 50, 1, 100)).toBe(10);
    expect(parsePositiveInt('0', 50, 1, 100)).toBe(1);
    expect(parsePositiveInt('9999', 50, 1, 100)).toBe(100);
  });

  it('rejeita valor não numérico', () => {
    expect(() => parsePositiveInt('abc', 50, 1, 100)).toThrow(AppError);
  });
});
