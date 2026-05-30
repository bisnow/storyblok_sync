/**
 * Story fetch I/O. Resolves requested slugs (plus ancestor folders) to full dev
 * stories, prefetches prod stories by natural key (for tree matching and the
 * link bridge), and fetches arbitrary dev stories by id/uuid (for resolving
 * cross-space links to stories outside the sync set).
 */
import { listAll } from '../lib/paginate';
import { pMap } from '../lib/p-map';
import { unwrap } from '../lib/result';
import type { Story, SyncClient } from '../types';
import { type ExistingTargetStories, expandSlugsWithAncestors, normalizeFullSlug, type TargetStoryRef } from './tree';

const CHUNK_SIZE = 100;

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const listByQuery = (client: SyncClient, spaceId: number, query: Record<string, unknown>, label: string): Promise<Story[]> =>
  listAll(
    page => client.stories.list({ path: { space_id: spaceId }, query: { ...query, page } } as any),
    (data: any) => (data.stories ?? []) as Story[],
    label,
  );

/**
 * Resolves the requested slugs (and all ancestor folders) to full dev stories.
 * Returns the de-duplicated full stories plus the requested slugs that did not
 * resolve to any dev story.
 */
export async function fetchDevStories(
  client: SyncClient,
  spaceId: number,
  requestedSlugs: string[],
): Promise<{ stories: Story[]; missingRequested: string[] }> {
  const allSlugs = expandSlugsWithAncestors(requestedSlugs);
  if (allSlugs.length === 0) {
    return { stories: [], missingRequested: [] };
  }

  const listStories = new Map<number, Story>();
  for (const slugs of chunk(allSlugs, CHUNK_SIZE)) {
    const page = await listByQuery(client, spaceId, { by_slugs: slugs.join(',') }, 'stories.list(by_slugs dev)');
    for (const story of page) { listStories.set(story.id, story); }
  }

  const presentSlugs = new Set<string>();
  for (const story of listStories.values()) {
    if (story.full_slug) { presentSlugs.add(normalizeFullSlug(story.full_slug)); }
  }
  const missingRequested = requestedSlugs.filter(slug => !presentSlugs.has(normalizeFullSlug(slug)));

  const stories = await pMap(
    [...listStories.values()],
    async listStory => unwrap(await client.stories.get(listStory.id, { path: { space_id: spaceId } }), `stories.get(${listStory.id})`) as any,
  );

  return { stories: stories.map((d: any) => d.story as Story), missingRequested };
}

const addRef = (result: ExistingTargetStories, story: Story): void => {
  const ref: TargetStoryRef = { id: story.id, uuid: story.uuid, is_folder: story.is_folder ?? false };
  if (story.full_slug) {
    const key = normalizeFullSlug(story.full_slug);
    const existing = result.bySlug.get(key);
    if (existing) {
      if (!existing.some(r => r.id === ref.id)) { existing.push(ref); }
    }
    else {
      result.bySlug.set(key, [ref]);
    }
  }
  result.byId.set(story.id, ref);
};

/** Prefetches prod stories matching the given slugs/ids into a lookup. */
export async function prefetchProdStoriesByKeys(
  client: SyncClient,
  spaceId: number,
  keys: { slugs?: Iterable<string>; ids?: Iterable<number> },
): Promise<ExistingTargetStories> {
  const result: ExistingTargetStories = { bySlug: new Map(), byId: new Map() };

  const slugSet = new Set<string>();
  for (const slug of keys.slugs ?? []) {
    if (slug) { slugSet.add(normalizeFullSlug(slug)); }
  }
  const idSet = new Set<number>();
  for (const id of keys.ids ?? []) {
    if (Number.isFinite(id)) { idSet.add(id); }
  }

  for (const slugs of chunk([...slugSet], CHUNK_SIZE)) {
    const page = await listByQuery(client, spaceId, { by_slugs: slugs.join(',') }, 'stories.list(by_slugs prod)');
    for (const story of page) { addRef(result, story); }
  }
  for (const ids of chunk([...idSet], CHUNK_SIZE)) {
    const page = await listByQuery(client, spaceId, { by_ids: ids.join(',') }, 'stories.list(by_ids prod)');
    for (const story of page) { addRef(result, story); }
  }

  return result;
}

/** Fetches lightweight dev stories by id/uuid (for cross-space link resolution). */
export async function fetchDevStoriesByKeys(
  client: SyncClient,
  spaceId: number,
  keys: { ids?: number[]; uuids?: string[] },
): Promise<Story[]> {
  const stories: Story[] = [];
  for (const ids of chunk([...new Set(keys.ids ?? [])], CHUNK_SIZE)) {
    if (ids.length === 0) { continue; }
    stories.push(...await listByQuery(client, spaceId, { by_ids: ids.join(',') }, 'stories.list(by_ids dev)'));
  }
  for (const uuids of chunk([...new Set(keys.uuids ?? [])], CHUNK_SIZE)) {
    if (uuids.length === 0) { continue; }
    stories.push(...await listByQuery(client, spaceId, { by_uuids: uuids.join(',') }, 'stories.list(by_uuids dev)'));
  }
  return stories;
}
