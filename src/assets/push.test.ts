import { describe, expect, it, vi } from 'vitest';
import { parseAssetSize, pushAssets } from './push';
import { silentLogger } from '../logger';
import type { SyncClient } from '../types';

const okList = (key: string, items: any[]) => ({
  data: { [key]: items },
  error: undefined,
  response: { status: 200, headers: new Headers({ Total: String(items.length), 'Per-Page': '100' }) },
  request: {},
});
const okData = (data: any) => ({ data, error: undefined, response: { status: 200, headers: new Headers() }, request: {} });

const devAsset = { id: 10, short_filename: 'hero.png', filename: 'https://dev.example/hero.png', alt: 'Hero', meta_data: {} };

const baseOptions = (devClient: SyncClient, prodClient: SyncClient) => ({
  devClient, prodClient, devSpaceId: 1, prodSpaceId: 2,
  filenames: ['hero.png'], logger: silentLogger,
  download: vi.fn(async () => new ArrayBuffer(8)),
});

const makeDev = (filename = 'https://dev.example/hero.png') => ({
  assets: { list: vi.fn(async () => okList('assets', [{ ...devAsset, filename }])) },
  assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
} as unknown as SyncClient);

describe('parseAssetSize', () => {
  it('extracts the WIDTHxHEIGHT segment from a Storyblok asset URL', () => {
    expect(parseAssetSize('https://a.storyblok.com/f/1/1400x900/abc/hero.png')).toBe('1400x900');
    expect(parseAssetSize('https://s3.amazonaws.com/a.storyblok.com/f/1/640x480/abc/hero.png')).toBe('640x480');
  });

  it('returns undefined when there is no dimensions segment', () => {
    expect(parseAssetSize('https://a.storyblok.com/f/1/abc/doc.pdf')).toBeUndefined();
    expect(parseAssetSize(undefined)).toBeUndefined();
  });
});

describe('pushAssets', () => {
  it('creates a new prod asset when none matches and maps by dev id', async () => {
    const dev = makeDev();
    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [])), // no existing prod asset
        upload: vi.fn(async () => ({ id: 500, short_filename: 'hero.png', filename: 'https://prod.example/hero.png' })),
        update: vi.fn(async () => undefined),
        get: vi.fn(async () => okData({ id: 500, short_filename: 'hero.png', filename: 'https://prod.example/hero.png' })),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: false });

    expect((prod.assets as any).upload).toHaveBeenCalledTimes(1);
    // No dimensions in the source URL → no `size` forwarded, and no replace `id`.
    const uploadBody = (prod.assets as any).upload.mock.calls[0][0].body;
    expect(uploadBody.size).toBeUndefined();
    expect(uploadBody.id).toBeUndefined();
    expect(result.counts).toMatchObject({ created: 1, updated: 0 });
    expect(result.assetMap.get(10)?.new.id).toBe(500);
    expect(result.changed).toBe(false);
    expect([...result.succeededFilenames]).toEqual(['hero.png']);
  });

  it('forwards the WIDTHxHEIGHT dimensions parsed from the dev URL to the upload', async () => {
    const dev = makeDev('https://s3.amazonaws.com/a.storyblok.com/f/1/1400x900/abc/hero.png');
    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [])),
        upload: vi.fn(async () => ({ id: 500, short_filename: 'hero.png', filename: 'https://a.storyblok.com/f/2/1400x900/def/hero.png' })),
        update: vi.fn(async () => undefined),
        get: vi.fn(async () => okData({ id: 500, short_filename: 'hero.png', filename: 'https://a.storyblok.com/f/2/1400x900/def/hero.png' })),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    await pushAssets({ ...baseOptions(dev, prod), dryRun: false });

    expect((prod.assets as any).upload.mock.calls[0][0].body).toMatchObject({ size: '1400x900' });
  });

  it('replaces an existing prod asset, re-gets the new filename and maps by both dev and prod id', async () => {
    const dev = makeDev();
    const existing = { id: 55, short_filename: 'hero.png', filename: 'https://prod.example/old.png' };
    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [existing])),
        upload: vi.fn(async () => ({ id: 55, short_filename: 'hero.png', filename: 'https://prod.example/new.png' })),
        update: vi.fn(async () => undefined),
        get: vi.fn(async () => okData({ id: 55, short_filename: 'hero.png', filename: 'https://prod.example/new.png', meta_data: { k: 1 } })),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: false });

    expect((prod.assets as any).upload).toHaveBeenCalledTimes(1);
    // Replace path passes the existing prod id so the upload swaps in place.
    expect((prod.assets as any).upload.mock.calls[0][0].body).toMatchObject({ id: 55 });
    expect(result.counts).toMatchObject({ updated: 1, created: 0 });
    expect(result.assetMap.get(10)?.new.filename).toBe('https://prod.example/new.png');
    expect(result.prodAssetMap.get(55)?.new.filename).toBe('https://prod.example/new.png');
    expect(result.changed).toBe(true);
  });

  it('makes no write calls in dry-run', async () => {
    const dev = makeDev();
    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [{ id: 55, short_filename: 'hero.png', filename: 'https://prod.example/old.png' }])),
        upload: vi.fn(), update: vi.fn(), create: vi.fn(), get: vi.fn(),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: true });
    expect((prod.assets as any).upload).not.toHaveBeenCalled();
    expect((prod.assets as any).update).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({ updated: 1 });
  });

  it('creates a shared asset folder only once when concurrent assets reference it', async () => {
    const folderId = 99;
    const dev = {
      assets: {
        list: vi.fn(async (args: any) => {
          const name = args.query.search as string;
          return okList('assets', [{ id: name === 'a.png' ? 1 : 2, short_filename: name, filename: `https://dev.example/${name}`, asset_folder_id: folderId, meta_data: {} }]);
        }),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [{ id: folderId, name: 'Images', parent_id: null }] })) },
    } as unknown as SyncClient;

    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [])), // no existing prod asset
        upload: vi.fn(async (args: any) => ({ id: 500, short_filename: args.body.short_filename, filename: `https://prod.example/${args.body.short_filename}` })),
        update: vi.fn(async () => undefined),
        get: vi.fn(async (id: number) => okData({ id, short_filename: 'x', filename: 'https://prod.example/x.png' })),
      },
      assetFolders: {
        list: vi.fn(async () => okData({ asset_folders: [] })), // folder missing in prod
        create: vi.fn(async () => okData({ asset_folder: { id: 700, name: 'Images', parent_id: null } })),
      },
    } as unknown as SyncClient;

    const result = await pushAssets({
      devClient: dev, prodClient: prod, devSpaceId: 1, prodSpaceId: 2,
      filenames: ['a.png', 'b.png'], logger: silentLogger,
      download: vi.fn(async () => new ArrayBuffer(8)), dryRun: false,
    });

    // The shared dev folder resolves to a single prod create despite two concurrent assets.
    expect((prod.assetFolders as any).create).toHaveBeenCalledTimes(1);
    expect(result.counts).toMatchObject({ created: 2 });
    expect((prod.assets as any).upload.mock.calls.every((c: any) => c[0].body.asset_folder_id === 700)).toBe(true);
  });

  it('warns and marks the filename failed when no dev asset is found', async () => {
    const dev = { assets: { list: vi.fn(async () => okList('assets', [])) }, assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) } } as unknown as SyncClient;
    const prod = { assets: { list: vi.fn(async () => okList('assets', [])) }, assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) } } as unknown as SyncClient;
    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: false });
    expect([...result.failedFilenames]).toEqual(['hero.png']);
    expect(result.assetMap.size).toBe(0);
  });
});
