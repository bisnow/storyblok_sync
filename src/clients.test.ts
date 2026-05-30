import { describe, expect, it } from 'vitest';
import { createInstrumentedClient } from './clients';
import { silentLogger, type Logger } from './logger';
import type { SyncClient } from './types';

const captureLogger = (): { logger: Logger; debug: string[] } => {
  const debug: string[] = [];
  return {
    debug,
    logger: { ...silentLogger, isDebug: true, debug: m => debug.push(m) },
  };
};

const fakeClient = (status = 200): SyncClient => ({
  stories: {
    get: async () => ({ data: { story: {} }, error: undefined, response: { status, headers: new Headers() }, request: {} }),
  },
} as unknown as SyncClient);

describe('createInstrumentedClient', () => {
  it('is a no-op pass-through when debug is off (returns the same client)', () => {
    const client = fakeClient();
    expect(createInstrumentedClient(client, 1, silentLogger)).toBe(client);
  });

  it('logs resource.method, space id, status and duration on each call', async () => {
    const { logger, debug } = captureLogger();
    const wrapped = createInstrumentedClient(fakeClient(200), 42, logger);
    await (wrapped.stories as any).get(101, { path: { space_id: 42 }, query: { page: 2 } });

    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('MAPI stories.get(101');
    expect(debug[0]).toContain('space=42');
    expect(debug[0]).toContain('→ 200');
    expect(debug[0]).toMatch(/\(\d+ms\)/);
  });

  it('never logs secret values from call arguments', async () => {
    const { logger, debug } = captureLogger();
    const wrapped = createInstrumentedClient(fakeClient(), 1, logger);
    await (wrapped.stories as any).get(1, { body: { secret: 'SUPERSECRET' } });
    expect(debug[0]).not.toContain('SUPERSECRET');
    expect(debug[0]).toContain('body={secret}'); // only the key name is shown
  });
});
