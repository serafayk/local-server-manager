import { describe, expect, it } from 'vitest';
import { extractBearerToken, extractQueryToken, generateApiToken, tokensMatch } from './auth';

describe('api auth', () => {
  it('gera tokens distintos e suficientemente longos', () => {
    const first = generateApiToken();
    const second = generateApiToken();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
  });

  it('compara tokens em tempo constante', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abc', '')).toBe(false);
  });

  it('extrai Bearer do header', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer   xyz')).toBe('xyz');
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('extrai token de query apenas de string não vazia', () => {
    expect(extractQueryToken('abc')).toBe('abc');
    expect(extractQueryToken('')).toBeNull();
    expect(extractQueryToken(['a'])).toBeNull();
    expect(extractQueryToken(undefined)).toBeNull();
  });
});
