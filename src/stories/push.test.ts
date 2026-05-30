import { describe, expect, it, vi } from 'vitest';
import { pushStories } from './push';
import { silentLogger } from '../logger';
import type { ComponentSchemas, Story, SyncClient } from '../types';

const okList = (items: any[]) => ({
  data: { stories: items },
  error: undefined,
  response: { status: 200, headers: new Headers({ Total: String(items.length), 'Per-Page': '100' }) },
  request: {},
});
const okStory = (story: any) => ({ data: { story }, error: undefined, response: { status: 200, headers: new Headers() }, request: {} });

const schemas: ComponentSchemas = { page: {} } as unknown as ComponentSchemas;

const folder = { id: 100, uuid: 'u100', name: 'en', slug: 'en', full_slug: 'en', is_folder: true, parent_id: 0, content: { _uid: 'f', component: undefined } } as unknown as Story;
const page = { id: 101, uuid: 'u101', name: 'Page', slug: 'page', full_slug: 'en/page', is_folder: false, parent_id: 100, published: true, content: { _uid: 'p', component: 'page' } } as unknown as Story;

const devClient = { stories: { list: vi.fn(async () => okList([])) } } as unknown as SyncClient;

const baseOptions = (prod: SyncClient) => ({
  prodClient: prod, devClient, prodSpaceId: 2, devSpaceId: 1,
  devStories: [folder, page], requestedSlugs: ['en/page'], missingRequested: [],
  schemas, assetMap: new Map(), logger: silentLogger,
});

describe('pushStories', () => {
  it('creates placeholders then updates content, resolving parent ids', async () => {
    let created = 0;
    const prod = {
      stories: {
        list: vi.fn(async () => okList([])), // nothing exists in prod yet
        create: vi.fn(async () => { created += 1; return okStory({ id: 9000 + created, uuid: `p${created}` }); }),
        update: vi.fn(async (_id: number, opts: any) => okStory(opts.body.story)),
      },
    } as unknown as SyncClient;

    const result = await pushStories({ ...baseOptions(prod), dryRun: false });

    expect((prod.stories as any).create).toHaveBeenCalledTimes(2);
    expect((prod.stories as any).update).toHaveBeenCalledTimes(2);
    // folder created first (id 9001), page second (id 9002) with parent resolved to the folder.
    const pageCreate = (prod.stories as any).create.mock.calls[1][0];
    expect(pageCreate.body.story.parent_id).toBe(9001);
    const pageUpdate = (prod.stories as any).update.mock.calls.find((c: any) => c[0] === 9002);
    expect(pageUpdate[1].body.story.parent_id).toBe(9001);
    expect(pageUpdate[1].body.publish).toBe(1); // page is published in dev
    expect(result.counts).toMatchObject({ created: 2, updated: 0, failed: 0 });
    expect([...result.succeededSlugs]).toEqual(['en/page']);
  });

  it('matches existing prod stories by slug and updates them (no create)', async () => {
    const existing = [
      { id: 9100, uuid: 'p100', full_slug: 'en', is_folder: true },
      { id: 9101, uuid: 'p101', full_slug: 'en/page', is_folder: false },
    ];
    const prod = {
      stories: {
        list: vi.fn(async () => okList(existing)),
        create: vi.fn(),
        update: vi.fn(async (_id: number, opts: any) => okStory(opts.body.story)),
      },
    } as unknown as SyncClient;

    const result = await pushStories({ ...baseOptions(prod), dryRun: false });

    expect((prod.stories as any).create).not.toHaveBeenCalled();
    expect((prod.stories as any).update).toHaveBeenCalledTimes(2);
    expect(result.counts).toMatchObject({ created: 0, updated: 2 });
    // page mapped onto prod id 9101, parent resolved to 9100
    const pageUpdate = (prod.stories as any).update.mock.calls.find((c: any) => c[0] === 9101);
    expect(pageUpdate[1].body.story.parent_id).toBe(9100);
  });

  it('makes no write calls in dry-run', async () => {
    const prod = {
      stories: { list: vi.fn(async () => okList([])), create: vi.fn(), update: vi.fn() },
    } as unknown as SyncClient;
    const result = await pushStories({ ...baseOptions(prod), dryRun: true });
    expect((prod.stories as any).create).not.toHaveBeenCalled();
    expect((prod.stories as any).update).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({ created: 2 });
  });

  it('marks missing requested slugs as failed', async () => {
    const prod = { stories: { list: vi.fn(async () => okList([])), create: vi.fn(async () => okStory({ id: 1, uuid: 'x' })), update: vi.fn(async (_i: number, o: any) => okStory(o.body.story)) } } as unknown as SyncClient;
    const result = await pushStories({ ...baseOptions(prod), requestedSlugs: ['en/page', 'en/missing'], missingRequested: ['en/missing'], dryRun: false });
    expect(result.failedSlugs.has('en/missing')).toBe(true);
  });
});
