/**
 * Asset push orchestrator (injected clients). For each requested filename:
 * search dev, download each match's binary, resolve its folder into prod
 * (match/create by name, best-effort hierarchy), then upsert into prod —
 * updating the existing asset (matched by `short_filename`) or creating a new
 * one. Records two map views:
 *
 *   - `assetMap`     keyed by **dev** asset id — for the story push (content
 *                    references dev ids before remap).
 *   - `prodAssetMap` keyed by **prod** asset id, only for pre-existing prod
 *                    assets that were replaced — for the update-stories pass
 *                    (existing prod stories reference prod ids).
 *
 * Updates re-`get` the asset so the new CDN filename is captured.
 */
import type { Logger } from '../logger';
import { toError, unwrap } from '../lib/result';
import { emptyCounts, type Asset, type AssetFolder, type AssetMap, type AssetMapped, type ResourceCounts, type SyncClient } from '../types';
import { findDevAssets } from './find';

export interface AssetPushResult {
  counts: ResourceCounts;
  assetMap: AssetMap;
  prodAssetMap: AssetMap;
  /** True when at least one pre-existing prod asset was replaced (triggers update-stories). */
  changed: boolean;
  succeededFilenames: Set<string>;
  failedFilenames: Set<string>;
}

export interface PushAssetsOptions {
  devClient: SyncClient;
  prodClient: SyncClient;
  devSpaceId: number;
  prodSpaceId: number;
  filenames: string[];
  dryRun: boolean;
  logger: Logger;
  onTick?: () => void;
  /** Downloads an asset binary; injectable for tests. */
  download?: (url: string) => Promise<ArrayBuffer>;
}

const defaultDownload = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download asset binary ${url}: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
};

const toMapped = (asset: Asset): AssetMapped => ({
  id: asset.id,
  filename: asset.filename,
  alt: asset.alt,
  title: asset.title,
  copyright: asset.copyright,
  source: asset.source,
  is_private: asset.is_private,
  meta_data: asset.meta_data,
});

const writableMetadata = (asset: Asset) => ({
  alt: asset.alt,
  title: asset.title,
  copyright: asset.copyright,
  source: asset.source,
  is_private: asset.is_private,
  focus: asset.focus,
  meta_data: asset.meta_data,
});

export async function pushAssets(options: PushAssetsOptions): Promise<AssetPushResult> {
  const { devClient, prodClient, devSpaceId, prodSpaceId, filenames, dryRun, logger, onTick } = options;
  const download = options.download ?? defaultDownload;

  const counts = emptyCounts();
  const assetMap: AssetMap = new Map();
  const prodAssetMap: AssetMap = new Map();
  const succeededFilenames = new Set<string>();
  const failedFilenames = new Set<string>();

  const folderResolver = await createFolderResolver({ devClient, prodClient, devSpaceId, prodSpaceId, dryRun, logger });

  for (const filename of filenames) {
    let fileOk = true;
    try {
      const found = await findDevAssets(devClient, devSpaceId, filename);
      const devMatches = found.exact.length > 0 ? found.exact : found.all;
      if (devMatches.length === 0) {
        logger.warning(`No dev asset found for "${filename}".`);
        failedFilenames.add(filename);
        continue;
      }
      if (found.exact.length === 0) {
        logger.warning(`No exact short_filename match for "${filename}"; using ${devMatches.length} fuzzy result(s).`);
      }

      for (const devAsset of devMatches) {
        try {
          await syncOneAsset(devAsset);
        }
        catch (maybeError) {
          counts.failed += 1;
          fileOk = false;
          logger.warning(`Failed to sync asset "${devAsset.short_filename}" (dev id ${devAsset.id}): ${toError(maybeError).message}`);
        }
      }
    }
    catch (maybeError) {
      counts.failed += 1;
      fileOk = false;
      logger.warning(`Failed to look up asset "${filename}": ${toError(maybeError).message}`);
    }
    finally {
      onTick?.();
    }
    if (fileOk) { succeededFilenames.add(filename); }
    else { failedFilenames.add(filename); }
  }

  return {
    counts,
    assetMap,
    prodAssetMap,
    changed: prodAssetMap.size > 0,
    succeededFilenames,
    failedFilenames,
  };

  async function syncOneAsset(devAsset: Asset): Promise<void> {
    const prodFolderId = await folderResolver.resolve(devAsset.asset_folder_id);
    const prodExisting = await findProdExisting(prodClient, prodSpaceId, devAsset.short_filename, logger);

    if (dryRun) {
      const mapped: AssetMapped = prodExisting ? toMapped(prodExisting) : { ...toMapped(devAsset) };
      assetMap.set(devAsset.id, { old: devAsset, new: mapped });
      if (prodExisting) {
        prodAssetMap.set(prodExisting.id, { old: prodExisting, new: mapped });
        counts.updated += 1;
        logger.info(`[dry-run] would replace prod asset "${devAsset.short_filename}" (prod id ${prodExisting.id})`);
      }
      else {
        counts.created += 1;
        logger.info(`[dry-run] would create prod asset "${devAsset.short_filename}"${prodFolderId ? ` in folder ${prodFolderId}` : ''}`);
      }
      return;
    }

    const fileBuffer = await download(devAsset.filename);

    if (prodExisting) {
      await prodClient.assets.update(prodExisting.id, {
        path: { space_id: prodSpaceId },
        body: { asset: { asset_folder_id: prodFolderId, ...writableMetadata(devAsset) }, short_filename: prodExisting.short_filename },
        file: fileBuffer,
      } as any);
      const fresh = unwrap(await prodClient.assets.get(prodExisting.id, { path: { space_id: prodSpaceId } }), `assets.get(${prodExisting.id})`) as Asset;
      const mapped = toMapped(fresh);
      assetMap.set(devAsset.id, { old: devAsset, new: mapped });
      prodAssetMap.set(prodExisting.id, { old: prodExisting, new: mapped });
      counts.updated += 1;
      logger.debug(`Replaced prod asset "${devAsset.short_filename}" (prod id ${prodExisting.id})`);
    }
    else {
      const created = await prodClient.assets.create({
        path: { space_id: prodSpaceId },
        body: { short_filename: devAsset.short_filename, asset_folder_id: prodFolderId, ...writableMetadata(devAsset) },
        file: fileBuffer,
      } as any) as Asset;
      assetMap.set(devAsset.id, { old: devAsset, new: toMapped(created) });
      counts.created += 1;
      logger.debug(`Created prod asset "${devAsset.short_filename}" (prod id ${created.id})`);
    }
  }
}

async function findProdExisting(prodClient: SyncClient, prodSpaceId: number, shortFilename: string, logger: Logger): Promise<Asset | undefined> {
  const { exact } = await findDevAssets(prodClient, prodSpaceId, shortFilename);
  if (exact.length > 1) {
    logger.warning(`Prod has ${exact.length} assets named "${shortFilename}"; matching the first (id ${exact[0].id}).`);
  }
  return exact[0];
}

interface FolderResolver {
  resolve: (devFolderId: number | undefined) => Promise<number | undefined>;
}

/**
 * Builds a best-effort dev→prod asset folder resolver: matches prod folders by
 * name, creating any missing ones (parents first). Falls back to root
 * (undefined) when a folder cannot be resolved.
 */
async function createFolderResolver({
  devClient,
  prodClient,
  devSpaceId,
  prodSpaceId,
  dryRun,
  logger,
}: {
  devClient: SyncClient;
  prodClient: SyncClient;
  devSpaceId: number;
  prodSpaceId: number;
  dryRun: boolean;
  logger: Logger;
}): Promise<FolderResolver> {
  const devFolders = (unwrap(await devClient.assetFolders.list({ path: { space_id: devSpaceId } }), 'assetFolders.list(dev)') as any).asset_folders ?? [];
  const prodFolders: AssetFolder[] = (unwrap(await prodClient.assetFolders.list({ path: { space_id: prodSpaceId } }), 'assetFolders.list(prod)') as any).asset_folders ?? [];

  const devById = new Map<number, AssetFolder>(devFolders.map((f: AssetFolder) => [f.id, f]));
  const prodByName = new Map<string, AssetFolder>(prodFolders.map(f => [f.name, f]));
  const cache = new Map<number, number | undefined>();

  const resolve = async (devFolderId: number | undefined): Promise<number | undefined> => {
    if (devFolderId == null) { return undefined; }
    if (cache.has(devFolderId)) { return cache.get(devFolderId); }
    const devFolder = devById.get(devFolderId);
    if (!devFolder) { return undefined; }

    const existing = prodByName.get(devFolder.name);
    if (existing) {
      cache.set(devFolderId, existing.id);
      return existing.id;
    }
    if (dryRun) {
      logger.info(`[dry-run] would create asset folder "${devFolder.name}"`);
      cache.set(devFolderId, undefined);
      return undefined;
    }

    const parentProdId = devFolder.parent_id != null ? await resolve(devFolder.parent_id) : undefined;
    try {
      const created = (unwrap(
        await prodClient.assetFolders.create({ path: { space_id: prodSpaceId }, body: { asset_folder: { name: devFolder.name, parent_id: parentProdId } } } as any),
        `assetFolders.create(${devFolder.name})`,
      ) as any).asset_folder as AssetFolder;
      prodByName.set(created.name, created);
      cache.set(devFolderId, created.id);
      return created.id;
    }
    catch (maybeError) {
      logger.warning(`Failed to create asset folder "${devFolder.name}"; placing asset at root: ${toError(maybeError).message}`);
      cache.set(devFolderId, undefined);
      return undefined;
    }
  };

  return { resolve };
}
