/**
 * Manual pagination over MAPI list endpoints. The client does not paginate for
 * us: list calls expose `Total` and `Per-Page` on `result.response.headers`, so
 * `listAll` loops pages until every item is collected.
 */
import type { ApiResponse } from '@storyblok/management-api-client';
import { unwrap } from './result';

const DEFAULT_PER_PAGE = 100;

/**
 * Computes the number of pages from the `Total` / `Per-Page` response headers.
 * Returns 1 when totals are missing or non-positive (single-page fallback).
 */
export function totalPagesFromHeaders(headers: Headers, fallbackPerPage = DEFAULT_PER_PAGE): number {
  const total = Number(headers.get('Total'));
  const perPage = Number(headers.get('Per-Page')) || fallbackPerPage;
  if (!Number.isFinite(total) || total <= 0 || perPage <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * Fetches every page of a list endpoint and returns the flattened items.
 *
 * @param fetchPage  Issues one page request (1-indexed). Must request the page
 *                   it is given; pagination math is driven by the headers it
 *                   returns.
 * @param selectItems  Pulls the item array out of the response envelope
 *                   (e.g. `data => data.stories`).
 * @param context  Label used in thrown errors.
 */
export async function listAll<TData, TItem>(
  fetchPage: (page: number) => Promise<ApiResponse<TData>>,
  selectItems: (data: TData) => TItem[],
  context = 'list',
): Promise<TItem[]> {
  const items: TItem[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await fetchPage(page);
    const data = unwrap(result, `${context} (page ${page})`);
    items.push(...selectItems(data));
    totalPages = totalPagesFromHeaders(result.response.headers);
    page += 1;
  } while (page <= totalPages);

  return items;
}
