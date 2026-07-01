/**
 * Finds dev assets by filename. The Management API's `search` query is a fuzzy
 * match, so we narrow to assets whose `short_filename` equals the requested
 * name. If none match exactly but the search returned results, we fall back to
 * those (and the caller warns) so a slightly-off name still has a chance.
 */
import type { Asset, SyncClient } from '../types';
import { listAll } from '../lib/paginate';

export interface FindAssetsResult {
  /** Assets whose short_filename exactly equals the query (preferred). */
  exact: Asset[];
  /** All assets the fuzzy search returned (for fallback / warnings). */
  all: Asset[];
}

export async function findDevAssets(client: SyncClient, spaceId: number, filename: string): Promise<FindAssetsResult> {
  const all = await listAll(
    page => client.assets.list({ path: { space_id: spaceId }, query: { page, per_page: 100, search: filename } }),
    (data: any) => (data.assets ?? []) as Asset[],
    `assets.list(search=${filename})`,
  );
  const exact = all.filter(asset => asset.short_filename === filename);
  return { exact, all };
}
