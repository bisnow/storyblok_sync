/**
 * Update-stories pass: after assets are replaced, repair their references in
 * prod stories that already exist (and are NOT in this sync's story set — those
 * get correct refs during the story push). Mirrors the CLI's
 * `mapAssetReferencesInStoriesPipeline`:
 *
 *  - Trigger only when at least one pre-existing prod asset changed (the caller
 *    checks `changed`).
 *  - When exactly one asset changed, narrow the scan with
 *    `query.reference_search`; otherwise scan all prod stories.
 *  - Remap with the prod-id-keyed asset map (stories map empty), and update only
 *    stories whose content actually changed.
 */
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

  const values = [...prodAssetMap.values()];
  const referenceSearch = values.length === 1 ? values[0].new.filename : undefined;

  const listStories = await listAll(
    page => prodClient.stories.list({
      path: { space_id: prodSpaceId },
      query: referenceSearch ? { page, reference_search: referenceSearch } : { page },
    }),
    (data: any) => (data.stories ?? []) as Story[],
    'stories.list(prod)',
  );

  logger.info(`Checking ${listStories.length} prod stor${listStories.length === 1 ? 'y' : 'ies'} for asset references to repair…`);

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
          await prodClient.stories.update(story.id, { path: { space_id: prodSpaceId }, body: { story: mapped, publish } } as any),
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
