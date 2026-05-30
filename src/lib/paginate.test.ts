import { describe, expect, it, vi } from 'vitest';
import { listAll, totalPagesFromHeaders } from './paginate';
import type { ApiResponse } from '@storyblok/management-api-client';

const ok = <T>(data: T, total: number, perPage = 100): ApiResponse<T> => ({
  data,
  error: undefined,
  response: { headers: new Headers({ Total: String(total), 'Per-Page': String(perPage) }) } as Response,
  request: {} as Request,
});

describe('totalPagesFromHeaders', () => {
  it('computes page count from Total / Per-Page', () => {
    expect(totalPagesFromHeaders(new Headers({ Total: '250', 'Per-Page': '100' }))).toBe(3);
    expect(totalPagesFromHeaders(new Headers({ Total: '100', 'Per-Page': '100' }))).toBe(1);
  });
  it('falls back to a single page when totals are missing or empty', () => {
    expect(totalPagesFromHeaders(new Headers())).toBe(1);
    expect(totalPagesFromHeaders(new Headers({ Total: '0', 'Per-Page': '100' }))).toBe(1);
  });
});

describe('listAll', () => {
  it('returns a single page without extra requests', async () => {
    const fetchPage = vi.fn(async () => ok({ items: ['a', 'b', 'c'] }, 3));
    const items = await listAll(fetchPage, d => d.items);
    expect(items).toEqual(['a', 'b', 'c']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('walks every page from the headers', async () => {
    const pages: Record<number, string[]> = { 1: ['a', 'b'], 2: ['c', 'd'], 3: ['e'] };
    const fetchPage = vi.fn(async (page: number) => ok({ items: pages[page] }, 5, 2));
    const items = await listAll(fetchPage, d => d.items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('handles an empty list', async () => {
    const fetchPage = vi.fn(async () => ok({ items: [] as string[] }, 0));
    expect(await listAll(fetchPage, d => d.items)).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
