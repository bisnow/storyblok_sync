/**
 * Story push orchestrator (injected clients). Two passes plus a cross-space
 * link bridge:
 *
 *  Pass 1 — build the folder/story tree: match each dev story to a prod story by
 *  normalized full_slug (reuse its id/uuid) or create a publish-0 placeholder
 *  under the resolved parent. Populates `storyMap` (dev id→prod id, dev
 *  uuid→prod uuid).
 *
 *  Link bridge — for every story-link reference in content not already mapped,
 *  resolve the dev story's full_slug, find the prod story with the same slug,
 *  and add the mapping. Unresolved links warn and pass through.
 *
 *  Pass 2 — remap references via `storyRefMapper` (stories + assets maps) and
 *  update each prod story, publishing per the dev story's published state.
 *
 * Validation runs first: schema drift / missing components warn (non-fatal).
 */
import type { Logger } from '../logger';
import { pMap } from '../lib/p-map';
import { toError, unwrap } from '../lib/result';
import { emptyCounts, type AssetMap, type ComponentSchemas, type ResourceCounts, type Story, type StoryMap, type SyncClient } from '../types';
import { fetchDevStoriesByKeys, prefetchProdStoriesByKeys } from './fetch';
import { bridgeStoryLinks, collectStoryLinkReferences, type StoryLinkRef } from './link-bridge';
import { storyRefMapper } from './ref-mapper';
import { findSlugMatch, groupStoriesByDepth, normalizeFullSlug, type StoryIndexEntry, toIndexEntry } from './tree';
import { formatStoryWarnings, validateStoryAgainstSchemas } from './validate';

export interface StoryPushResult {
  counts: ResourceCounts;
  storyMap: StoryMap;
  succeededSlugs: Set<string>;
  failedSlugs: Set<string>;
}

export interface PushStoriesOptions {
  prodClient: SyncClient;
  devClient: SyncClient;
  prodSpaceId: number;
  devSpaceId: number;
  devStories: Story[];
  requestedSlugs: string[];
  missingRequested: string[];
  schemas: ComponentSchemas;
  assetMap: AssetMap;
  dryRun: boolean;
  logger: Logger;
  onTick?: () => void;
}

export async function pushStories(options: PushStoriesOptions): Promise<StoryPushResult> {
  const { prodClient, devClient, prodSpaceId, devSpaceId, devStories, requestedSlugs, missingRequested, schemas, assetMap, dryRun, logger, onTick } = options;

  const counts = emptyCounts();
  const storyMap: StoryMap = new Map();
  const succeededSlugs = new Set<string>();
  const failedSlugs = new Set<string>();

  for (const slug of missingRequested) {
    logger.warning(`Requested story slug "${slug}" was not found in dev.`);
    failedSlugs.add(slug);
  }
  if (devStories.length === 0) {
    return { counts, storyMap, succeededSlugs, failedSlugs };
  }

  // Validate content against schemas (non-fatal warnings).
  for (const story of devStories) {
    for (const warning of formatStoryWarnings(story, validateStoryAgainstSchemas(story, schemas))) {
      logger.warning(warning);
    }
  }

  // Build index entries.
  const entries: StoryIndexEntry[] = [];
  const devStoryById = new Map<number, Story>();
  for (const story of devStories) {
    try {
      entries.push(toIndexEntry(story));
      devStoryById.set(story.id, story);
    }
    catch (maybeError) {
      counts.failed += 1;
      if (story.full_slug) { failedSlugs.add(story.full_slug); }
      logger.warning(toError(maybeError).message);
    }
  }

  // ---- Pass 1: build the tree ----
  const existing = await prefetchProdStoriesByKeys(prodClient, prodSpaceId, { slugs: entries.map(e => e.full_slug) });
  const claimed = new Set<number>();
  const origin = new Map<number, 'created' | 'matched'>();
  const pass1Failed = new Set<number>();
  const levels = groupStoriesByDepth(entries);

  const createOrMatch = async (entry: StoryIndexEntry): Promise<void> => {
    try {
      const match = findSlugMatch(entry, existing, claimed);
      if (match) {
        claimed.add(match.id);
        storyMap.set(entry.id, match.id);
        storyMap.set(entry.uuid, match.uuid);
        origin.set(entry.id, 'matched');
        return;
      }

      if (!entry.is_folder && !entry.component) {
        throw new Error(`Story "${entry.slug}" is missing a content type (content.component).`);
      }

      const resolvedParentId = entry.parent_id != null ? storyMap.get(entry.parent_id) : undefined;

      if (dryRun) {
        storyMap.set(entry.id, entry.id);
        storyMap.set(entry.uuid, entry.uuid);
        origin.set(entry.id, 'created');
        logger.info(`[dry-run] would create story "${entry.full_slug}"`);
        return;
      }

      const created = (unwrap(
        await prodClient.stories.create({
          path: { space_id: prodSpaceId },
          body: {
            story: {
              slug: entry.slug,
              name: entry.name,
              is_folder: entry.is_folder,
              ...(resolvedParentId != null ? { parent_id: Number(resolvedParentId) } : {}),
              ...(entry.is_startpage && resolvedParentId != null ? { is_startpage: true } : {}),
              ...(entry.component ? { content: { _uid: '', component: entry.component } } : {}),
            },
            publish: 0,
          },
        } as any),
        `stories.create(${entry.full_slug})`,
      ) as any).story as Story;

      storyMap.set(entry.id, created.id);
      storyMap.set(entry.uuid, created.uuid);
      origin.set(entry.id, 'created');
    }
    catch (maybeError) {
      pass1Failed.add(entry.id);
      counts.failed += 1;
      if (entry.full_slug) { failedSlugs.add(entry.full_slug); }
      logger.warning(`Failed to create/match story "${entry.full_slug}": ${toError(maybeError).message}`);
    }
  };

  for (const level of levels) {
    // Folders before non-folders so a startpage's same-level parent folder exists.
    await pMap(level.filter(e => e.is_folder), createOrMatch);
    await pMap(level.filter(e => !e.is_folder), createOrMatch);
  }

  // ---- Link bridge ----
  await bridgeLinks({ devStories, schemas, storyMap, devClient, devSpaceId, prodClient, prodSpaceId, existing, logger });

  // ---- Pass 2: remap + update ----
  const succeededDevIds = new Set<number>();
  await pMap(entries, async (entry) => {
    if (pass1Failed.has(entry.id) || !storyMap.has(entry.id)) { return; }
    const devStory = devStoryById.get(entry.id);
    if (!devStory) { return; }

    try {
      const mapped = storyRefMapper(devStory, { schemas, maps: { stories: storyMap, assets: assetMap } });
      const prodId = Number(storyMap.get(entry.id));
      const publish = entry.is_folder ? 0 : (devStory.published ? 1 : 0);

      if (dryRun) {
        logger.info(`[dry-run] would update story "${entry.full_slug}" (publish=${publish})`);
      }
      else {
        unwrap(
          await prodClient.stories.update(prodId, { path: { space_id: prodSpaceId }, body: { story: mapped, publish } } as any),
          `stories.update(${prodId})`,
        );
      }
      succeededDevIds.add(entry.id);
      if (origin.get(entry.id) === 'created') { counts.created += 1; }
      else { counts.updated += 1; }
    }
    catch (maybeError) {
      counts.failed += 1;
      if (entry.full_slug) { failedSlugs.add(entry.full_slug); }
      logger.warning(`Failed to update story "${entry.full_slug}": ${toError(maybeError).message}`);
    }
    finally {
      onTick?.();
    }
  });

  // ---- Map requested slugs to success/failure for sync-file clearing ----
  const normalizedToDevId = new Map<string, number>();
  for (const entry of entries) { normalizedToDevId.set(normalizeFullSlug(entry.full_slug), entry.id); }
  for (const slug of requestedSlugs) {
    if (missingRequested.includes(slug)) { continue; }
    const devId = normalizedToDevId.get(normalizeFullSlug(slug));
    if (devId != null && succeededDevIds.has(devId)) { succeededSlugs.add(slug); }
    else { failedSlugs.add(slug); }
  }

  return { counts, storyMap, succeededSlugs, failedSlugs };
}

/**
 * Resolves and adds cross-space story-link mappings. Fetches dev stories
 * referenced but outside the sync set (to learn their full_slug), prefetches the
 * matching prod stories, then bridges by slug.
 */
async function bridgeLinks({
  devStories,
  schemas,
  storyMap,
  devClient,
  devSpaceId,
  prodClient,
  prodSpaceId,
  existing,
  logger,
}: {
  devStories: Story[];
  schemas: ComponentSchemas;
  storyMap: StoryMap;
  devClient: SyncClient;
  devSpaceId: number;
  prodClient: SyncClient;
  prodSpaceId: number;
  existing: Awaited<ReturnType<typeof prefetchProdStoriesByKeys>>;
  logger: Logger;
}): Promise<void> {
  const references: StoryLinkRef[] = devStories.flatMap(story => collectStoryLinkReferences(story, schemas));
  if (references.length === 0) { return; }

  const devById = new Map(devStories.map(s => [s.id, s] as const));
  const devByUuid = new Map(devStories.map(s => [s.uuid, s] as const));

  const needIds = [...new Set(references.filter(r => r.id != null && !devById.has(r.id) && !storyMap.has(r.id)).map(r => r.id!))];
  const needUuids = [...new Set(references.filter(r => r.uuid != null && !devByUuid.has(r.uuid) && !storyMap.has(r.uuid)).map(r => r.uuid!))];
  if (needIds.length > 0 || needUuids.length > 0) {
    const extra = await fetchDevStoriesByKeys(devClient, devSpaceId, { ids: needIds, uuids: needUuids });
    for (const story of extra) {
      devById.set(story.id, story);
      devByUuid.set(story.uuid, story);
    }
  }

  const resolveDevFullSlug = (ref: StoryLinkRef): string | undefined => {
    const story = ref.uuid != null ? devByUuid.get(ref.uuid) : (ref.id != null ? devById.get(ref.id) : undefined);
    return story?.full_slug ?? undefined;
  };

  const candidateSlugs = new Set<string>();
  for (const ref of references) {
    const fullSlug = resolveDevFullSlug(ref);
    if (fullSlug) { candidateSlugs.add(normalizeFullSlug(fullSlug)); }
  }
  const prodExisting = await prefetchProdStoriesByKeys(prodClient, prodSpaceId, { slugs: candidateSlugs });

  const resolveProdBySlug = (slug: string): { id: number; uuid: string } | undefined => {
    const refs = prodExisting.bySlug.get(slug) ?? existing.bySlug.get(slug);
    if (!refs || refs.length === 0) { return undefined; }
    const ref = refs.find(r => !r.is_folder) ?? refs[0];
    return { id: ref.id, uuid: ref.uuid };
  };

  const { added, unresolved } = bridgeStoryLinks({
    references,
    storyMap,
    resolveDevFullSlug,
    resolveProdBySlug,
    onWarn: message => logger.warning(message),
  });

  if (added > 0) { logger.debug(`Bridged ${added} cross-space story link mapping(s).`); }
  if (unresolved.length > 0) { logger.info(`${unresolved.length} story link(s) could not be bridged and were left unchanged.`); }
}
