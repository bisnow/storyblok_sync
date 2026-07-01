/**
 * Finds assets by filename (used for both the dev source lookup and the prod
 * existing-asset lookup). The Management API's `search` is a fuzzy substring
 * match with no exact-filename filter, so a generic name like `1.jpg` also
 * matches `21.jpg`, `101.jpg`, `231.jpg`, … — potentially thousands of results
 * across dozens of pages. Walking all of them just to filter down to one exact
 * `short_filename` was the dominant cost of the asset phase (86% of MAPI calls).
 *
 * So we sort by `short_filename` ascending — which clusters the exact match near
 * the front for these numeric names — and paginate lazily, stopping as soon as
 * the exact match appears. Only when NO exact match exists do we walk every page,
 * so the fuzzy fallback (which the caller uses only when there's no exact hit)
 * still sees the full result set.
 */
import type { Asset, SyncClient } from '../types';
import { totalPagesFromHeaders } from '../lib/paginate';
import { unwrap } from '../lib/result';

export interface FindAssetsResult {
  /** Assets whose short_filename exactly equals the query (preferred). */
  exact: Asset[];
  /** Assets scanned so far (for fuzzy fallback / warnings). Complete only when no exact match was found. */
  all: Asset[];
}

export async function findDevAssets(client: SyncClient, spaceId: number, filename: string): Promise<FindAssetsResult> {
  const all: Asset[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await client.assets.list({
      path: { space_id: spaceId },
      query: { page, per_page: 100, search: filename, sort_by: 'short_filename:asc' },
    });
    const data = unwrap(result, `assets.list(search=${filename}, page ${page})`) as { assets?: Asset[] };
    all.push(...(data.assets ?? []));

    // Short-circuit: once the exact short_filename appears we have everything any
    // caller needs, so stop paginating the fuzzy result set. sort_by keeps this
    // to page 1 for generic names in the common case.
    const exact = all.filter(asset => asset.short_filename === filename);
    if (exact.length > 0) {
      return { exact, all };
    }

    totalPages = totalPagesFromHeaders(result.response.headers);
    page += 1;
  } while (page <= totalPages);

  return { exact: [], all };
}
