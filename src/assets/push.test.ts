import { describe, expect, it, vi } from 'vitest';
import { pushAssets } from './push';
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

const makeDev = () => ({
  assets: { list: vi.fn(async () => okList('assets', [devAsset])) },
  assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
} as unknown as SyncClient);

describe('pushAssets', () => {
  it('creates a new prod asset when none matches and maps by dev id', async () => {
    const dev = makeDev();
    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [])), // no existing prod asset
        create: vi.fn(async () => ({ id: 500, short_filename: 'hero.png', filename: 'https://prod.example/hero.png' })),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: false });

    expect((prod.assets as any).create).toHaveBeenCalledTimes(1);
    expect(result.counts).toMatchObject({ created: 1, updated: 0 });
    expect(result.assetMap.get(10)?.new.id).toBe(500);
    expect(result.changed).toBe(false);
    expect([...result.succeededFilenames]).toEqual(['hero.png']);
  });

  it('replaces an existing prod asset, re-gets the new filename and maps by both dev and prod id', async () => {
    const dev = makeDev();
    const existing = { id: 55, short_filename: 'hero.png', filename: 'https://prod.example/old.png' };
    const prod = {
      assets: {
        list: vi.fn(async () => okList('assets', [existing])),
        update: vi.fn(async () => undefined),
        get: vi.fn(async () => okData({ id: 55, short_filename: 'hero.png', filename: 'https://prod.example/new.png', meta_data: { k: 1 } })),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: false });

    expect((prod.assets as any).update).toHaveBeenCalledTimes(1);
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
        update: vi.fn(), create: vi.fn(), get: vi.fn(),
      },
      assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) },
    } as unknown as SyncClient;

    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: true });
    expect((prod.assets as any).update).not.toHaveBeenCalled();
    expect((prod.assets as any).create).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({ updated: 1 });
  });

  it('warns and marks the filename failed when no dev asset is found', async () => {
    const dev = { assets: { list: vi.fn(async () => okList('assets', [])) }, assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) } } as unknown as SyncClient;
    const prod = { assets: { list: vi.fn(async () => okList('assets', [])) }, assetFolders: { list: vi.fn(async () => okData({ asset_folders: [] })) } } as unknown as SyncClient;
    const result = await pushAssets({ ...baseOptions(dev, prod), dryRun: false });
    expect([...result.failedFilenames]).toEqual(['hero.png']);
    expect(result.assetMap.size).toBe(0);
  });
});
