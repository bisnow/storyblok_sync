/**
 * HTTP-level integration against the REAL SDK using undici's MockAgent.
 * Exercises the two pieces our orchestrators rely on that the pure tests cannot
 * reach: header-driven pagination, and the three-step asset upload flow
 * (sign → S3 POST → finalize → get, then metadata update).
 *
 * The installed `undici` major matches Node's built-in undici, so
 * `setGlobalDispatcher(mockAgent)` makes the native global `fetch` (used by the
 * SDK) route through the MockAgent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { createManagementApiClient } from '@storyblok/management-api-client';
import { listAll } from './lib/paginate';

let agent: MockAgent;
let originalDispatcher: Dispatcher;

const makeClient = () => createManagementApiClient({
  personalAccessToken: 'token',
  spaceId: 2,
  region: 'us',
  baseUrl: 'http://mapi.mock',
  rateLimit: false,
  retry: { limit: 0 },
});

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
});

describe('pagination (real SDK + MockAgent)', () => {
  it('walks every page using the Total / Per-Page headers', async () => {
    agent.get('http://mapi.mock')
      .intercept({ path: (p: string) => p.startsWith('/v1/spaces/2/stories'), method: 'GET' })
      .reply((opts: { path: string }) => {
        const page = new URL(`http://x${opts.path}`).searchParams.get('page') ?? '1';
        const stories = page === '1' ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
        return { statusCode: 200, data: { stories }, responseOptions: { headers: { 'content-type': 'application/json', 'Total': '3', 'Per-Page': '2' } } };
      })
      .persist();

    const client = makeClient();
    const items = await listAll(page => client.stories.list({ query: { page } }), (d: any) => d.stories);
    expect(items.map((s: any) => s.id)).toEqual([1, 2, 3]);
  });
});

describe('asset upload flow (real SDK + MockAgent)', () => {
  it('signs, uploads to S3, finalizes, gets, then updates metadata', async () => {
    const calls = { signed: false, uploaded: false, finalized: false, gets: 0, metadataUpdated: false };
    const sb = agent.get('http://mapi.mock');
    const s3 = agent.get('http://s3.mock');

    sb.intercept({ path: '/v1/spaces/2/assets', method: 'POST' })
      .reply(() => {
        calls.signed = true;
        return { statusCode: 200, data: { id: 123, post_url: 'http://s3.mock/upload', fields: { key: 'f/2/x/hero.png', 'Content-Type': 'image/png' } }, responseOptions: { headers: { 'content-type': 'application/json' } } };
      })
      .persist();

    s3.intercept({ path: '/upload', method: 'POST' })
      .reply(() => { calls.uploaded = true; return { statusCode: 204, data: '' }; })
      .persist();

    sb.intercept({ path: '/v1/spaces/2/assets/123/finish_upload', method: 'GET' })
      .reply(() => { calls.finalized = true; return { statusCode: 200, data: {}, responseOptions: { headers: { 'content-type': 'application/json' } } }; })
      .persist();

    sb.intercept({ path: '/v1/spaces/2/assets/123', method: 'GET' })
      .reply(() => {
        calls.gets += 1;
        return { statusCode: 200, data: { id: 123, filename: 'https://a.storyblok.com/f/2/x/hero.png', short_filename: 'hero.png', alt: calls.metadataUpdated ? 'Hero' : null }, responseOptions: { headers: { 'content-type': 'application/json' } } };
      })
      .persist();

    sb.intercept({ path: '/v1/spaces/2/assets/123', method: 'PUT' })
      .reply(() => { calls.metadataUpdated = true; return { statusCode: 204, data: '' }; })
      .persist();

    const client = makeClient();
    const asset = await client.assets.create({ body: { short_filename: 'hero.png', alt: 'Hero' }, file: new ArrayBuffer(8) });

    expect(asset.id).toBe(123);
    expect(asset.filename).toBe('https://a.storyblok.com/f/2/x/hero.png');
    expect(calls).toMatchObject({ signed: true, uploaded: true, finalized: true, metadataUpdated: true });
    expect(calls.gets).toBeGreaterThanOrEqual(1);
  });
});
