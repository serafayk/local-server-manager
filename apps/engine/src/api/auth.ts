import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Token aleatório por execução do Engine. */
export function generateApiToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Comparação em tempo constante, sem vazar tamanho por curto-circuito. */
export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function extractQueryToken(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
