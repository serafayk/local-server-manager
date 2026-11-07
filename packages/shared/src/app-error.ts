import type { ErrorCode } from '@lsm/contracts';

/**
 * Erro de domínio tipado. Toda falha esperada atravessa o sistema como
 * AppError, nunca como string solta. `code` é estável e faz parte do contrato.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    const base: { code: ErrorCode; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      base.details = this.details;
    }
    return base;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (isAppError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError(fallback, error.message, undefined, { cause: error });
  }
  return new AppError(fallback, String(error));
}
