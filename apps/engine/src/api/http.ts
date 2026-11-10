import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OperationError } from '@lsm/contracts';
import { operationFailure, operationSuccess } from '@lsm/contracts';
import { AppError, newRequestId } from '@lsm/shared';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function requestIdOf(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  if (typeof header === 'string' && header.length > 0 && header.length <= 128) {
    return header;
  }
  return newRequestId();
}

export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  requestId: string,
  status = 200,
): FastifyReply {
  return reply.status(status).send(operationSuccess(data, requestId, new Date().toISOString()));
}

export function sendFailure(
  reply: FastifyReply,
  error: OperationError,
  requestId: string,
  status: number,
): FastifyReply {
  return reply.status(status).send(operationFailure(error, requestId, new Date().toISOString()));
}

/**
 * Proteção contra DNS rebinding: o Host precisa ser loopback na porta real
 * do servidor ou um hostname explicitamente autorizado (painel atrás de
 * túnel/proxy). Requisições com Origin são validadas pelo CORS.
 */
export function isAllowedHostHeader(
  host: unknown,
  port: number,
  extraHosts: readonly string[] = [],
): boolean {
  const parsed = splitHost(host);
  if (parsed === null) {
    return false;
  }
  if (LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed.port === port;
  }
  return extraHosts.some((allowed) => allowed === parsed.hostname);
}

export function isLoopbackHost(host: unknown): boolean {
  const parsed = splitHost(host);
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** `host` no formato do cabeçalho (hostname[:porta], IPv6 entre colchetes). */
export function splitHost(host: unknown): { hostname: string; port: number | null } | null {
  if (typeof host !== 'string' || host.length === 0) {
    return null;
  }
  try {
    const url = new URL(`http://${host}`);
    if (url.hostname === '' || url.pathname !== '/') {
      return null;
    }
    return {
      hostname: url.hostname.toLowerCase(),
      port: url.port === '' ? null : Number.parseInt(url.port, 10),
    };
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: unknown, allowedOrigins: readonly string[]): boolean {
  if (origin === undefined) {
    return true; // clientes não-browser (curl, CLI, testes)
  }
  if (typeof origin !== 'string') {
    return false;
  }
  return allowedOrigins.includes(origin);
}

export function parsePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new AppError('VALIDATION_ERROR', `valor numérico inválido: ${value}`);
  }
  return Math.min(max, Math.max(min, parsed));
}
