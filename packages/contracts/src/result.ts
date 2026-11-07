import type { OperationError } from './errors';

/**
 * Envelope único de resposta — docs/06-API-CONTRACTS.md §2.
 * Nunca inclui stack trace.
 */
export interface OperationSuccess<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

export interface OperationFailure {
  success: false;
  error: OperationError;
  requestId: string;
  timestamp: string;
}

export type OperationResult<T> = OperationSuccess<T> | OperationFailure;

export function operationSuccess<T>(
  data: T,
  requestId: string,
  timestamp: string,
): OperationSuccess<T> {
  return { success: true, data, requestId, timestamp };
}

export function operationFailure(
  error: OperationError,
  requestId: string,
  timestamp: string,
): OperationFailure {
  return { success: false, error, requestId, timestamp };
}
