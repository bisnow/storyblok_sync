/**
 * Update-stories pass: after assets are replaced, repair their references in
 * prod stories that already exist (and are NOT in this sync's story set — those
 * get correct refs during the story push). Mirrors the CLI's
 * `mapAssetReferencesInStoriesPipeline`:
 *
 *  - Trigger only when at least one pre-existing prod asset changed (the caller
 *    checks `changed`).
 *  - For each replaced asset, find candidate stories with
 *    `query.reference_search` on the asset's OLD (pre-replace) filename — that is
 *    the URL existing prod stories still hold — and union the matches. We never
 *    list the whole space (that scan was the slow path that had to be canceled).
 *  - Remap with the prod-id-keyed asset map (stories map empty), and update only
 *    stories whose content actually changed.
 */
import { normalizeAssetUrl } from '@storyblok/management-api-client';
import type { Logger } from '../logger';
import { listAll } from '../lib/paginate';
import { pMap } from '../lib/p-map';
import { toError, unwrap } from '../lib/result';
import { emptyCounts, type AssetMap, type ComponentSchemas, type ResourceCounts, type Story, type SyncClient } from '../types';
import { storyRefMapper } from '../stories/ref-mapper';
import { isStoryPublishedWithoutChanges } from '../stories/publish-state';

export interface UpdateStoriesOptions {
  prodClient: SyncClient;
  prodSpaceId: number;
  schemas: ComponentSchemas;
  /** Asset map keyed by prod asset id (the ids existing prod stories reference). */
  prodAssetMap: AssetMap;
  dryRun: boolean;
  logger: Logger;
}

export async function updateStoriesAssetRefs(options: UpdateStoriesOptions): Promise<ResourceCounts> {
  const { prodClient, prodSpaceId, schemas, prodAssetMap, dryRun, logger } = options;
  const counts = emptyCounts();

  if (prodAssetMap.size === 0) {
    return counts;
  }
  if (Object.keys(schemas).length === 0) {
    logger.warning('Skipping update-stories: no component schemas available to identify asset fields.');
    return counts;
  }

  // One narrow search per replaced asset, unioned by story id. Existing prod
  // stories reference the asset's OLD url (pre-replace), normalized the same way
  // the ref-mapper writes asset urls into content — so that is what we search.
  // Searching the NEW filename (the prior behavior) matched nothing, since no
  // existing story holds it yet.
  const candidates = new Map<number, Story>();
  for (const { old, new: replacement } of prodAssetMap.values()) {
    const term = normalizeAssetUrl(old?.filename ?? replacement.filename);
    const matches = await listAll(
      page => prodClient.stories.list({ path: { space_id: prodSpaceId }, query: { page, per_page: 100, reference_search: term } }),
      (data: any) => (data.stories ?? []) as Story[],
      `stories.list(prod, ref=${term})`,
    );
    for (const story of matches) { candidates.set(story.id, story); }
  }

  const listStories = [...candidates.values()];
  logger.info(`Checking ${listStories.length} prod stor${listStories.length === 1 ? 'y' : 'ies'} referencing ${prodAssetMap.size} replaced asset(s)…`);

  await pMap(listStories, async (listStory) => {
    try {
      const full = unwrap(await prodClient.stories.get(listStory.id, { path: { space_id: prodSpaceId } }), `stories.get(${listStory.id})`) as any;
      const story = full.story as Story;
      const mapped = storyRefMapper(story, { schemas, maps: { assets: prodAssetMap, stories: new Map() } });

      if (JSON.stringify(story.content) === JSON.stringify(mapped.content)) {
        counts.skipped += 1;
        return;
      }

      const publish = isStoryPublishedWithoutChanges(story) ? 1 : 0;
      if (dryRun) {
        logger.info(`[dry-run] would update asset refs in prod story "${story.full_slug || story.slug}" (id ${story.id})`);
      }
      else {
        unwrap(
          await prodClient.stories.update(story.id, { path: { space_id: prodSpaceId }, body: { story: mapped, force_update: '1', ...(publish ? { publish } : {}) } } as any),
          `stories.update(${story.id})`,
        );
      }
      counts.updated += 1;
    }
    catch (maybeError) {
      counts.failed += 1;
      logger.warning(`Failed to update asset refs in prod story id ${listStory.id}: ${toError(maybeError).message}`);
    }
  });

  return counts;
}
