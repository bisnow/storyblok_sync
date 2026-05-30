/**
 * Action entry point. Orchestrates the dev → prod sync in dependency order
 * (components → assets → stories → update-stories), then optionally clears
 * fully-succeeded sync files, writes a job-summary table and sets outputs.
 * Exits non-zero on a fatal error, or on partial failure when `fail-on-partial`.
 */
import * as core from '@actions/core';
import { readConfig } from './config';
import { createClients } from './clients';
import { createLogger, type Logger } from './logger';
import { toError } from './lib/result';
import { ProgressTracker } from './lib/progress';
import { clearProcessedFiles, readSyncDir, type FailedItems } from './sync-file';
import { emptyCounts, type ResourceCounts } from './types';
import { buildDependencyGraph } from './components/graph';
import { buildSchemas, fetchAllComponentsData, fetchTargetState } from './components/fetch';
import { collectDependencyClosure } from './components/closure';
import { pushComponents } from './components/push';
import { pushAssets } from './assets/push';
import { updateStoriesAssetRefs } from './assets/update-stories';
import { fetchDevStories } from './stories/fetch';
import { pushStories } from './stories/push';
import type { AssetMap } from './types';

const sum = (counts: ResourceCounts): number => counts.created + counts.updated;
const hasFailures = (counts: ResourceCounts): boolean => counts.failed > 0;

async function run(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.debug);
  const { dev, prod } = createClients(config, logger);

  if (config.dryRun) {
    logger.info('Running in dry-run mode — no writes will be made.');
  }

  const { files, merged } = await readSyncDir(config.syncDir);
  logger.info(`Loaded ${files.length} sync file(s): ${merged.components.length} component(s), ${merged.assets.length} asset(s), ${merged.stories.length} story slug(s).`);

  const componentCounts = emptyCounts();
  const assetCounts = emptyCounts();
  const storyCounts = emptyCounts();
  const updateStoryCounts = emptyCounts();
  const failed: FailedItems = { components: new Set(), stories: new Set(), assets: new Set() };

  let assetMap: AssetMap = new Map();
  let prodAssetMap: AssetMap = new Map();
  let assetsChanged = false;

  // ---- Components (always pull dev set to build schemas) ----
  logger.startSection('Components');
  // Always pull the full dev component set so story validation + ref-mapping
  // have every schema, even when no components are requested. A failure here is
  // fatal (caught at the top level) since nothing downstream can proceed.
  const devComponentsData = await fetchAllComponentsData(dev, config.devSpaceId);
  const schemas = buildSchemas(devComponentsData.components);

  if (merged.components.length > 0) {
    try {
      const closure = collectDependencyClosure(merged.components, devComponentsData);
      const unknown = merged.components.filter(name => !closure.components.some(c => c.name === name));
      for (const name of unknown) {
        logger.warning(`Requested component "${name}" was not found in dev.`);
        failed.components.add(name);
      }

      const targetState = await fetchTargetState(prod, config.prodSpaceId);
      const graph = buildDependencyGraph(closure, targetState.indexed, message => logger.warning(message));

      const localComponentById = new Map(closure.components.map(c => [c.id, c.name]));
      const localPresetKeys = new Set<string>();
      for (const preset of closure.presets) {
        const componentName = localComponentById.get(preset.component_id);
        if (componentName) { localPresetKeys.add(`${componentName}:${preset.name}`); }
      }

      logger.info(`Syncing ${closure.components.length} component(s) (incl. dependencies)…`);
      const result = await pushComponents({
        client: prod,
        spaceId: config.prodSpaceId,
        graph,
        localPresetKeys,
        targetPresets: targetState.indexed.presets,
        dryRun: config.dryRun,
        prunePresets: config.prunePresets,
        logger,
      });
      Object.assign(componentCounts, result.counts);
      for (const name of result.failedComponentNames) { failed.components.add(name); }
      logger.info(`Components done: ${componentCounts.created} created, ${componentCounts.updated} updated, ${componentCounts.failed} failed.`);
    }
    catch (maybeError) {
      logger.error(`Component sync failed: ${toError(maybeError).message}`);
      componentCounts.failed += 1;
      for (const name of merged.components) { failed.components.add(name); }
    }
  }
  else {
    logger.info('No components requested; pulled dev schemas for story validation only.');
  }
  logger.endSection();

  // ---- Assets ----
  logger.startSection('Assets');
  if (merged.assets.length > 0) {
    const progress = new ProgressTracker({ label: 'Assets', total: merged.assets.length, log: m => logger.info(m) });
    progress.start('assets');
    try {
      const result = await pushAssets({
        devClient: dev,
        prodClient: prod,
        devSpaceId: config.devSpaceId,
        prodSpaceId: config.prodSpaceId,
        filenames: merged.assets,
        dryRun: config.dryRun,
        logger,
        onTick: () => progress.tick(),
      });
      Object.assign(assetCounts, result.counts);
      assetMap = result.assetMap;
      prodAssetMap = result.prodAssetMap;
      assetsChanged = result.changed;
      for (const name of result.failedFilenames) { failed.assets.add(name); }
    }
    catch (maybeError) {
      logger.error(`Asset sync failed: ${toError(maybeError).message}`);
      assetCounts.failed += 1;
      for (const name of merged.assets) { failed.assets.add(name); }
    }
    progress.end(assetCounts);
  }
  else {
    logger.info('No assets requested.');
  }
  logger.endSection();

  // ---- Stories ----
  logger.startSection('Stories');
  if (merged.stories.length > 0) {
    try {
      const { stories, missingRequested } = await fetchDevStories(dev, config.devSpaceId, merged.stories);
      const progress = new ProgressTracker({ label: 'Stories', total: stories.length, log: m => logger.info(m) });
      progress.start('stories');
      const result = await pushStories({
        prodClient: prod,
        devClient: dev,
        prodSpaceId: config.prodSpaceId,
        devSpaceId: config.devSpaceId,
        devStories: stories,
        requestedSlugs: merged.stories,
        missingRequested,
        schemas,
        assetMap,
        dryRun: config.dryRun,
        logger,
        onTick: () => progress.tick(),
      });
      Object.assign(storyCounts, result.counts);
      for (const slug of result.failedSlugs) { failed.stories.add(slug); }
      progress.end(storyCounts);
    }
    catch (maybeError) {
      logger.error(`Story sync failed: ${toError(maybeError).message}`);
      storyCounts.failed += 1;
      for (const slug of merged.stories) { failed.stories.add(slug); }
    }
  }
  else {
    logger.info('No stories requested.');
  }
  logger.endSection();

  // ---- Update-stories (repair asset refs in existing prod stories) ----
  if (config.updateStories && assetsChanged && prodAssetMap.size > 0) {
    logger.startSection('Update stories (asset refs)');
    try {
      const counts = await updateStoriesAssetRefs({
        prodClient: prod,
        prodSpaceId: config.prodSpaceId,
        schemas,
        prodAssetMap,
        dryRun: config.dryRun,
        logger,
      });
      Object.assign(updateStoryCounts, counts);
      logger.info(`Update-stories done: ${counts.updated} updated, ${counts.skipped} unchanged, ${counts.failed} failed.`);
    }
    catch (maybeError) {
      logger.error(`Update-stories failed: ${toError(maybeError).message}`);
      updateStoryCounts.failed += 1;
    }
    logger.endSection();
  }

  // ---- Clear processed files ----
  let clearedFiles: string[] = [];
  if (config.clearProcessedFiles && !config.dryRun && files.length > 0) {
    clearedFiles = await clearProcessedFiles(files, failed);
    if (clearedFiles.length > 0) {
      logger.info(`Cleared ${clearedFiles.length} fully-succeeded sync file(s): ${clearedFiles.join(', ')}`);
    }
  }

  // ---- Summary + outputs ----
  writeSummary(logger, { componentCounts, assetCounts, storyCounts, updateStoryCounts });

  core.setOutput('components-synced', sum(componentCounts));
  core.setOutput('assets-synced', sum(assetCounts));
  core.setOutput('stories-synced', sum(storyCounts));
  core.setOutput('cleared-files', clearedFiles.join(','));
  const summaryLine = `components: ${sum(componentCounts)}, assets: ${sum(assetCounts)}, stories: ${sum(storyCounts)}, repaired: ${updateStoryCounts.updated}`;
  core.setOutput('summary', summaryLine);

  const anyFailure
    = hasFailures(componentCounts) || hasFailures(assetCounts) || hasFailures(storyCounts) || hasFailures(updateStoryCounts)
      || failed.components.size > 0 || failed.assets.size > 0 || failed.stories.size > 0;

  if (anyFailure && config.failOnPartial) {
    core.setFailed(`Sync completed with failures (${summaryLine}). See annotations above.`);
  }
  else {
    logger.info(`Sync complete — ${summaryLine}.`);
  }
}

function writeSummary(
  logger: Logger,
  counts: { componentCounts: ResourceCounts; assetCounts: ResourceCounts; storyCounts: ResourceCounts; updateStoryCounts: ResourceCounts },
): void {
  const row = (label: string, c: ResourceCounts): string[] => [label, String(c.created), String(c.updated), String(c.skipped), String(c.failed)];
  logger.summaryTable(
    ['Resource', 'Created', 'Updated', 'Skipped', 'Failed'],
    [
      row('Components', counts.componentCounts),
      row('Assets', counts.assetCounts),
      row('Stories', counts.storyCounts),
      row('Stories (asset refs)', counts.updateStoryCounts),
    ],
  );
  // No GITHUB_STEP_SUMMARY available (e.g. local run) — ignore failures.
  Promise.resolve(core.summary.write()).catch(() => {});
}

run().catch((maybeError) => {
  core.setFailed(toError(maybeError).message);
});
