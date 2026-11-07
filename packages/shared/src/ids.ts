import { randomUUID } from 'node:crypto';

/** UUID v4 para entidades persistidas. */
export function newId(): string {
  return randomUUID();
}

/** Identificador de correlação de uma operação/comando. */
export function newRequestId(): string {
  return randomUUID();
}
