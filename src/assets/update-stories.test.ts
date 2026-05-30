import { describe, expect, it, vi } from 'vitest';
import { updateStoriesAssetRefs } from './update-stories';
import { silentLogger } from '../logger';
import type { AssetMap, ComponentSchemas, SyncClient } from '../types';

const okList = (items: any[]) => ({
  data: { stories: items },
  error: undefined,
  response: { status: 200, headers: new Headers({ Total: String(items.length), 'Per-Page': '100' }) },
  request: {},
});
const okStory = (story: any) => ({ data: { story }, error: undefined, response: { status: 200, headers: new Headers() }, request: {} });

const schemas: ComponentSchemas = { page: { img: { type: 'asset' } } } as unknown as ComponentSchemas;

const prodAssetMap: AssetMap = new Map([[
  55,
  { old: {} as any, new: { id: 55, filename: 'https://prod.example/new.png', meta_data: {} } as any },
]]);

const storyWithRef = { id: 1, uuid: 'a', parent_id: 0, slug: 's1', full_slug: 'en/s1', published: true, unpublished_changes: false, content: { _uid: 'x', component: 'page', img: { fieldtype: 'asset', id: 55, filename: 'https://prod.example/old.png' } } };
const storyWithoutRef = { id: 2, uuid: 'b', parent_id: 0, slug: 's2', full_slug: 'en/s2', content: { _uid: 'y', component: 'page', img: { fieldtype: 'asset', id: 999, filename: 'https://prod.example/other.png' } } };

const makeProd = () => ({
  stories: {
    list: vi.fn(async () => okList([{ id: 1 }, { id: 2 }])),
    get: vi.fn(async (id: number) => okStory(id === 1 ? storyWithRef : storyWithoutRef)),
    update: vi.fn(async (_id: number, opts: any) => okStory(opts.body.story)),
  },
} as unknown as SyncClient);

describe('updateStoriesAssetRefs', () => {
  it('updates only stories whose asset references actually change', async () => {
    const prod = makeProd();
    const counts = await updateStoriesAssetRefs({ prodClient: prod, prodSpaceId: 2, schemas, prodAssetMap, dryRun: false, logger: silentLogger });

    expect((prod.stories as any).update).toHaveBeenCalledTimes(1);
    const call = (prod.stories as any).update.mock.calls[0];
    expect(call[0]).toBe(1);
    expect(call[1].body.story.content.img.filename).toBe('https://prod.example/new.png');
    expect(call[1].body.publish).toBe(1);
    expect(counts).toMatchObject({ updated: 1, skipped: 1, failed: 0 });
  });

  it('narrows the scan with reference_search when exactly one asset changed', async () => {
    const prod = makeProd();
    await updateStoriesAssetRefs({ prodClient: prod, prodSpaceId: 2, schemas, prodAssetMap, dryRun: false, logger: silentLogger });
    expect((prod.stories as any).list.mock.calls[0][0].query.reference_search).toBe('https://prod.example/new.png');
  });

  it('makes no write calls in dry-run', async () => {
    const prod = makeProd();
    const counts = await updateStoriesAssetRefs({ prodClient: prod, prodSpaceId: 2, schemas, prodAssetMap, dryRun: true, logger: silentLogger });
    expect((prod.stories as any).update).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ updated: 1, skipped: 1 });
  });
});
