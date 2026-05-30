/**
 * Pure helpers for the story folder/story tree: slug normalization, ancestor
 * expansion, lightweight index entries, depth grouping (folders before
 * non-folders at each level) and slug matching against existing prod stories.
 * Ported from the monoblok CLI's stories streams/constants/actions.
 */
import type { Story } from '../types';

export type TargetStoryRef = { id: number; uuid: string; is_folder: boolean };

export interface ExistingTargetStories {
  bySlug: Map<string, TargetStoryRef[]>;
  byId: Map<number, TargetStoryRef>;
}

export interface StoryIndexEntry {
  id: number;
  uuid: string;
  slug: string;
  name: string;
  full_slug: string;
  is_folder: boolean;
  is_startpage: boolean;
  parent_id: number | null;
  component?: string;
}

/** Strips a single trailing slash so `a/b/` and `a/b` compare equal. */
export const normalizeFullSlug = (slug: string): string => slug.replace(/\/$/, '');

/**
 * Expands each requested slug to include all of its ancestor folder paths, so
 * the parent tree can be fetched/created before the leaves.
 * `en/blog/post` → `en`, `en/blog`, `en/blog/post`.
 */
export const expandSlugsWithAncestors = (slugs: string[]): string[] => {
  const out = new Set<string>();
  for (const raw of slugs) {
    const normalized = normalizeFullSlug(raw);
    if (!normalized) { continue; }
    const segments = normalized.split('/');
    for (let i = 1; i <= segments.length; i++) {
      out.add(segments.slice(0, i).join('/'));
    }
  }
  return [...out];
};

/** Builds a lightweight index entry (metadata, no full content) from a story. */
export const toIndexEntry = (story: Story): StoryIndexEntry => {
  if (!story.uuid) {
    throw new Error(`Story "${story.full_slug || story.slug}" is missing a uuid and cannot be pushed.`);
  }
  return {
    id: story.id,
    uuid: story.uuid,
    slug: story.slug ?? '',
    name: story.name ?? '',
    full_slug: story.full_slug ?? '',
    is_folder: story.is_folder ?? false,
    is_startpage: story.is_startpage === true,
    parent_id: story.parent_id ?? null,
    component: story.content?.component,
  };
};

const depthOf = (fullSlug: string): number => {
  const slug = normalizeFullSlug(fullSlug || '');
  return slug === '' ? 0 : slug.split('/').length - 1;
};

/**
 * Groups index entries into dependency levels by full_slug depth, folders first
 * within each level. Parent-before-child is guaranteed by the level ordering;
 * folders-first keeps a folder ahead of its same-depth startpage.
 */
export const groupStoriesByDepth = (entries: StoryIndexEntry[]): StoryIndexEntry[][] => {
  const depthMap = new Map<number, StoryIndexEntry[]>();
  for (const entry of entries) {
    const depth = depthOf(entry.full_slug);
    if (!depthMap.has(depth)) { depthMap.set(depth, []); }
    depthMap.get(depth)!.push(entry);
  }

  const maxDepth = depthMap.size > 0 ? Math.max(...depthMap.keys()) : 0;
  const levels: StoryIndexEntry[][] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const level = depthMap.get(d);
    if (!level || level.length === 0) { continue; }
    level.sort((a, b) => {
      if (a.is_folder && !b.is_folder) { return -1; }
      if (!a.is_folder && b.is_folder) { return 1; }
      return 0;
    });
    levels.push(level);
  }
  return levels;
};

/**
 * Finds an unclaimed prod story matching this entry's normalized full_slug,
 * preferring the same `is_folder` (a folder and its startpage share a slug).
 */
export const findSlugMatch = (
  entry: StoryIndexEntry,
  existing: ExistingTargetStories,
  claimedRemoteIds: Set<number>,
): TargetStoryRef | undefined => {
  const normalizedSlug = entry.full_slug ? normalizeFullSlug(entry.full_slug) : undefined;
  const candidates = normalizedSlug ? existing.bySlug.get(normalizedSlug) : undefined;
  if (!candidates) { return undefined; }
  const unclaimed = candidates.filter(ref => !claimedRemoteIds.has(ref.id));
  return unclaimed.find(ref => ref.is_folder === entry.is_folder) ?? unclaimed[0];
};
