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
    const status = result.response?.status;
    const body = (result.error as { data?: unknown })?.data;
    const detail = body ? ` — ${stringifyError(body)}` : '';
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
