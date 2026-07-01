import { describe, expect, it, vi } from 'vitest';
import { findDevAssets } from './find';
import type { SyncClient } from '../types';

// A paginated fuzzy response; `Total`/`Per-Page` headers drive listAll's loop.
const pageOf = (assets: any[], total: number) => ({
  data: { assets },
  error: undefined,
  response: { status: 200, headers: new Headers({ Total: String(total), 'Per-Page': '2' }) },
  request: {},
});

describe('findDevAssets', () => {
  it('stops paginating as soon as the exact short_filename is found', async () => {
    // 6 fuzzy matches across 3 pages (Per-Page 2); exact "1.jpg" is on page 1.
    const list = vi.fn(async (args: any) =>
      args.query.page === 1
        ? pageOf([{ id: 1, short_filename: '1.jpg' }, { id: 2, short_filename: '21.jpg' }], 6)
        : pageOf([{ id: 99, short_filename: '31.jpg' }], 6));
    const client = { assets: { list } } as unknown as SyncClient;

    const res = await findDevAssets(client, 1, '1.jpg');

    expect(res.exact.map(a => a.id)).toEqual([1]);
    expect(list).toHaveBeenCalledTimes(1); // did NOT walk pages 2-3
  });

  it('keeps paginating until the exact match appears on a later page', async () => {
    const list = vi.fn(async (args: any) => {
      if (args.query.page === 1) return pageOf([{ id: 2, short_filename: '21.jpg' }, { id: 3, short_filename: '31.jpg' }], 6);
      if (args.query.page === 2) return pageOf([{ id: 1, short_filename: '1.jpg' }, { id: 4, short_filename: '41.jpg' }], 6);
      return pageOf([{ id: 5, short_filename: '51.jpg' }], 6);
    });
    const client = { assets: { list } } as unknown as SyncClient;

    const res = await findDevAssets(client, 1, '1.jpg');

    expect(res.exact.map(a => a.id)).toEqual([1]);
    expect(list).toHaveBeenCalledTimes(2); // stopped at page 2, not page 3
  });

  it('walks every page for the fuzzy fallback when no exact match exists', async () => {
    const list = vi.fn(async (args: any) =>
      args.query.page === 1
        ? pageOf([{ id: 2, short_filename: '21.jpg' }, { id: 3, short_filename: '31.jpg' }], 4)
        : pageOf([{ id: 4, short_filename: '41.jpg' }, { id: 5, short_filename: '51.jpg' }], 4));
    const client = { assets: { list } } as unknown as SyncClient;

    const res = await findDevAssets(client, 1, '1.jpg');

    expect(res.exact).toEqual([]);
    expect(res.all).toHaveLength(4);
    expect(list).toHaveBeenCalledTimes(2); // walked both pages
  });

  it('requests short_filename ascending sort so exact matches cluster early', async () => {
    const list = vi.fn(async () => pageOf([{ id: 1, short_filename: '1.jpg' }], 1));
    const client = { assets: { list } } as unknown as SyncClient;

    await findDevAssets(client, 1, '1.jpg');

    expect(list.mock.calls[0][0].query).toMatchObject({ sort_by: 'short_filename:asc', search: '1.jpg', per_page: 100 });
  });
});
