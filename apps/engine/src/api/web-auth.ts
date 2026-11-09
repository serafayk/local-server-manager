import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Repositories } from '@lsm/database';
import type { Clock } from '@lsm/shared';

export const WEB_AUTH_KEY = 'web-auth';
export const SESSION_COOKIE = 'lsm_session';
export const CSRF_COOKIE = 'lsm_csrf';
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;

interface StoredAuth {
  salt: string;
  hash: string;
  createdAt: string;
}

interface Session {
  csrf: string;
  expiresAt: number;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  csrf: string | null;
}

export interface LoginResult {
  ok: boolean;
  sessionId: string | null;
  csrf: string | null;
  error: string | null;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '') {
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

function cookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; maxAge?: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${String(options.maxAge ?? SESSION_TTL_MS / 1_000)}`,
  ];
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  return parts.join('; ');
}

/**
 * Autenticação da Web UI: senha única (scrypt), sessão em memória e CSRF por
 * sessão. O token Bearer continua valendo para o desktop e integrações.
 */
export class WebAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly repositories: Repositories,
    private readonly clock: Clock,
  ) {}

  isConfigured(): boolean {
    return this.readStored() !== null;
  }

  setPassword(password: string): void {
    if (password.length < 8) {
      throw new Error('A senha precisa ter ao menos 8 caracteres.');
    }
    const salt = randomBytes(16).toString('base64');
    const hash = scryptSync(password, salt, 64).toString('base64');
    this.repositories.settings.set(
      WEB_AUTH_KEY,
      { salt, hash, createdAt: this.clock.nowIso() } satisfies StoredAuth,
      this.clock.nowIso(),
    );
    // Nova senha invalida sessões antigas.
    this.sessions.clear();
  }

  verify(password: string): boolean {
    const stored = this.readStored();
    if (!stored) {
      return false;
    }
    const expected = Buffer.from(stored.hash, 'base64');
    const actual = scryptSync(password, stored.salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Cria sessão após validar a senha, com limite de tentativas por IP. */
  login(ip: string, password: string): LoginResult {
    if (!this.isConfigured()) {
      return { ok: false, sessionId: null, csrf: null, error: 'Senha ainda não configurada' };
    }
    if (this.tooManyAttempts(ip)) {
      return {
        ok: false,
        sessionId: null,
        csrf: null,
        error: 'Muitas tentativas. Aguarde um minuto e tente novamente.',
      };
    }
    if (!this.verify(password)) {
      this.registerFailure(ip);
      return { ok: false, sessionId: null, csrf: null, error: 'Senha incorreta' };
    }
    this.failures.delete(ip);
    return { ok: true, ...this.createSession(), error: null };
  }

  createSession(): { sessionId: string; csrf: string } {
    const sessionId = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    this.sessions.set(sessionId, { csrf, expiresAt: this.clock.nowMs() + SESSION_TTL_MS });
    this.prune();
    return { sessionId, csrf };
  }

  sessionIdFrom(cookieHeader: string | undefined): string | null {
    const id = parseCookieHeader(cookieHeader)[SESSION_COOKIE];
    if (!id) {
      return null;
    }
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= this.clock.nowMs()) {
      this.sessions.delete(id);
      return null;
    }
    return id;
  }

  csrfOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.csrf ?? null;
  }

  destroy(sessionId: string | null): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
  }

  status(cookieHeader: string | undefined): AuthStatus {
    const sessionId = this.sessionIdFrom(cookieHeader);
    return {
      configured: this.isConfigured(),
      authenticated: sessionId !== null,
      csrf: sessionId === null ? null : this.csrfOf(sessionId),
    };
  }

  static sessionCookie(sessionId: string): string {
    return cookie(SESSION_COOKIE, sessionId, { httpOnly: true });
  }

  static csrfCookie(csrf: string): string {
    return cookie(CSRF_COOKIE, csrf, { httpOnly: false });
  }

  static clearCookies(): string[] {
    return [
      cookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }),
      cookie(CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 }),
    ];
  }

  private readStored(): StoredAuth | null {
    const value = this.repositories.settings.get<StoredAuth>(WEB_AUTH_KEY);
    if (!value || typeof value.salt !== 'string' || typeof value.hash !== 'string') {
      return null;
    }
    return value;
  }

  private prune(): void {
    const now = this.clock.nowMs();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  private tooManyAttempts(ip: string): boolean {
    const now = this.clock.nowMs();
    const attempts = (this.failures.get(ip) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    this.failures.set(ip, attempts);
    return attempts.length >= LOGIN_MAX_ATTEMPTS;
  }

  private registerFailure(ip: string): void {
    const now = this.clock.nowMs();
    const attempts = (this.failures.get(ip) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    attempts.push(now);
    this.failures.set(ip, attempts);
  }
}
