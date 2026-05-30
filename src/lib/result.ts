/**
 * `unwrap()` collapses the MAPI client's discriminated `{ data, error }` union
 * into either the data or a thrown `SyncError`, so business logic can read
 * linearly instead of branching on every call.
 */
import type { ApiResponse } from '@storyblok/management-api-client';

export class SyncError extends Error {
  readonly status?: number;
  readonly cause?: unknown;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'SyncError';
    this.status = options?.status;
    this.cause = options?.cause;
  }
}

/**
 * Returns `result.data` or throws a `SyncError` describing the failure.
 * `context` labels the operation in the thrown message (e.g. `stories.update(101)`).
 */
export function unwrap<T>(result: ApiResponse<T>, context = 'MAPI request'): T {
  if (result.error) {
    // The MAPI client's `result.error` is a ClientError whose HTTP body lives at
    // `error.response.data` (NOT `error.data`); status/statusText live there too.
    // Reading `.data` directly always yielded undefined, so 422 validation
    // messages were silently dropped from the thrown error.
    const clientError = result.error as {
      response?: { status?: number; statusText?: string; data?: unknown };
    };
    const status = clientError.response?.status ?? result.response?.status;
    const body = clientError.response?.data;
    const detail = body !== undefined && body !== null && body !== ''
      ? ` — ${stringifyError(body)}`
      : clientError.response?.statusText
        ? ` — ${clientError.response.statusText}`
        : '';
    throw new SyncError(`${context} failed${status ? ` (HTTP ${status})` : ''}${detail}`, {
      status,
      cause: result.error,
    });
  }
  return result.data;
}

function stringifyError(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  try {
    return JSON.stringify(body);
  }
  catch {
    return String(body);
  }
}

/** Narrow any thrown value to an `Error` with a usable `.message`. */
export function toError(maybeError: unknown): Error {
  if (maybeError instanceof Error) {
    return maybeError;
  }
  return new Error(typeof maybeError === 'string' ? maybeError : JSON.stringify(maybeError));
}
