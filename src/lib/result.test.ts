import { describe, expect, it } from 'vitest';
import { SyncError, unwrap } from './result';

describe('unwrap', () => {
  it('returns data on success', () => {
    const result = { data: { ok: true }, error: undefined, response: { status: 200 }, request: {} } as any;
    expect(unwrap(result)).toEqual({ ok: true });
  });

  it('surfaces the 422 validation body (which lives at error.response.data, not error.data)', () => {
    const result = {
      data: undefined,
      // Shape of the MAPI client's ClientError: body is nested under response.data.
      error: { response: { status: 422, statusText: 'Unprocessable Entity', data: { error: 'slug already taken' } } },
      response: { status: 422 },
      request: {},
    } as any;
    expect(() => unwrap(result, 'stories.update(1)')).toThrow(SyncError);
    expect(() => unwrap(result, 'stories.update(1)')).toThrow(/HTTP 422/);
    expect(() => unwrap(result, 'stories.update(1)')).toThrow(/slug already taken/);
    expect(() => unwrap(result, 'stories.update(1)')).toThrow(/stories\.update\(1\)/);
  });

  it('falls back to statusText when the error body is empty', () => {
    const result = {
      data: undefined,
      error: { response: { status: 422, statusText: 'Unprocessable Entity', data: undefined } },
      response: { status: 422 },
      request: {},
    } as any;
    expect(() => unwrap(result)).toThrow(/Unprocessable Entity/);
  });
});
