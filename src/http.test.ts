/**
 * HTTP-level integration against the REAL SDK using undici's MockAgent.
 * Exercises the two pieces our orchestrators rely on that the pure tests cannot
 * reach: header-driven pagination, and the three-step asset upload flow
 * (sign → S3 POST → finalize → get, then metadata update).
 *
 * `setGlobalDispatcher(mockAgent)` only reroutes the native global `fetch` (used
 * by the SDK) when the installed `undici` major equals Node's built-in undici
 * major — otherwise the two manipulate different globals and the request escapes
 * to the real network (ENOTFOUND). The repo pins both to Node 24 / undici 7 via
 * .nvmrc + the `undici` devDependency; the guard below fails loudly on CI if that
 * ever drifts, and skips (not silently passes) on a mismatched local Node.
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { createManagementApiClient } from '@storyblok/management-api-client';
import { listAll } from './lib/paginate';

const installedUndiciMajor = String(createRequire(import.meta.url)('undici/package.json').version).split('.')[0];
const builtinUndiciMajor = String(process.versions.undici ?? '').split('.')[0];
const undiciMatches = installedUndiciMajor === builtinUndiciMajor;
const onCI = Boolean(process.env.CI);

describe('http test environment', () => {
  it('installed undici major matches Node built-in (required for MockAgent interception)', () => {
    // On CI a mismatch must fail here rather than let the real-SDK suites skip
    // and silently drop coverage. Locally we tolerate a mismatched Node — the
    // suites below skip with a note instead of a cryptic ENOTFOUND.
    if (onCI) {
      expect(
        undiciMatches,
        `Node built-in undici (${builtinUndiciMajor}.x) must match installed undici (${installedUndiciMajor}.x); `
        + `align .nvmrc and the \`undici\` devDependency (currently Node 24 / undici 7).`,
      ).toBe(true);
    }
    else if (!undiciMatches) {
      console.warn(`[http.test] real-SDK suites skipped: Node undici ${builtinUndiciMajor}.x != installed ${installedUndiciMajor}.x — use the Node in .nvmrc.`);
    }
  });
});

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

describe.skipIf(!undiciMatches)('pagination (real SDK + MockAgent)', () => {
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

describe.skipIf(!undiciMatches)('asset upload flow (real SDK + MockAgent)', () => {
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
