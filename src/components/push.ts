/**
 * Component push orchestrator (injected client). Drives the dependency graph:
 * for each processing level it resolves references against already-upserted prod
 * resources, then upserts each node (create when absent, update when present by
 * natural key). Component-only circular whitelists are handled by creating
 * minimal stubs first so references can resolve, then updating. After the push,
 * stale presets of successfully-pushed components are optionally pruned.
 *
 * Dry-run performs no writes: it logs the intended create/update per node and
 * seeds fake target data so dependent levels still resolve.
 */
import type { Logger } from '../logger';
import { toError, unwrap } from '../lib/result';
import { emptyCounts, type ResourceCounts, type SyncClient } from '../types';
import { type DependencyGraph, determineProcessingOrder, type GraphNode, type ProcessingLevel, type TargetComponentsState } from './graph';
import { resolveReferences } from './remap';

export interface ComponentPushResult {
  counts: ResourceCounts;
  successfulComponentNames: Set<string>;
  failedComponentNames: Set<string>;
}

export interface PushComponentsOptions {
  client: SyncClient;
  spaceId: number;
  graph: DependencyGraph;
  /** Composite `component:preset` keys present in the dev (local) set. */
  localPresetKeys: Set<string>;
  /** Prod presets indexed by composite key (for stale-preset pruning). */
  targetPresets: TargetComponentsState['presets'];
  dryRun: boolean;
  prunePresets: boolean;
  logger: Logger;
}

const resourceLabel: Record<GraphNode['type'], string> = {
  tag: 'tag',
  group: 'group',
  component: 'component',
  preset: 'preset',
};

export async function pushComponents(options: PushComponentsOptions): Promise<ComponentPushResult> {
  const { client, spaceId, graph, localPresetKeys, targetPresets, dryRun, prunePresets, logger } = options;
  const counts = emptyCounts();
  const successfulComponentNames = new Set<string>();
  const failedComponentNames = new Set<string>();

  const preExisting = new Set<string>(
    [...graph.nodes.values()].filter(node => node.targetData).map(node => node.id),
  );

  const upsertNode = async (node: GraphNode): Promise<{ resource: any; id: number }> => {
    const existingId = node.targetData?.id;
    const body = node.sourceData;
    switch (node.type) {
      case 'tag': {
        const result = existingId != null
          ? unwrap(await client.internalTags.update(existingId, { path: { space_id: spaceId }, body } as any), `internalTags.update(${existingId})`)
          : unwrap(await client.internalTags.create({ path: { space_id: spaceId }, body } as any), `internalTags.create(${node.name})`);
        const resource = (result as any).internal_tag;
        return { resource, id: resource.id };
      }
      case 'group': {
        const result = existingId != null
          ? unwrap(await client.componentFolders.update(existingId, { path: { space_id: spaceId }, body: { component_group: body } } as any), `componentFolders.update(${existingId})`)
          : unwrap(await client.componentFolders.create({ path: { space_id: spaceId }, body: { component_group: body } } as any), `componentFolders.create(${node.name})`);
        const resource = (result as any).component_group;
        return { resource, id: resource.id };
      }
      case 'component': {
        const result = existingId != null
          ? unwrap(await client.components.update(existingId, { path: { space_id: spaceId }, body: { component: body } } as any), `components.update(${existingId})`)
          : unwrap(await client.components.create({ path: { space_id: spaceId }, body: { component: body } } as any), `components.create(${node.name})`);
        const resource = (result as any).component;
        return { resource, id: resource.id };
      }
      case 'preset': {
        const result = existingId != null
          ? unwrap(await client.presets.update(existingId, { path: { space_id: spaceId }, body: { preset: body } } as any), `presets.update(${existingId})`)
          : unwrap(await client.presets.create({ path: { space_id: spaceId }, body: { preset: body } } as any), `presets.create(${node.name})`);
        const resource = (result as any).preset;
        return { resource, id: resource.id };
      }
    }
  };

  const createStubs = async (nodeIds: string[]): Promise<void> => {
    for (const nodeId of nodeIds) {
      const node = graph.nodes.get(nodeId);
      if (!node || node.type !== 'component' || node.targetData) { continue; }
      logger.debug(`Creating stub component for circular dependency: ${node.name}`);
      if (dryRun) {
        node.targetData = { resource: { ...node.sourceData }, id: node.sourceData.id };
        continue;
      }
      const result = unwrap(
        await client.components.create({ path: { space_id: spaceId }, body: { component: { name: node.name, display_name: node.name, schema: {} } } } as any),
        `components.create(stub ${node.name})`,
      ) as any;
      node.targetData = { resource: result.component, id: result.component.id };
    }
  };

  const processLevel = async (level: ProcessingLevel): Promise<void> => {
    if (level.isCyclic) {
      logger.debug(`Resolving circular component level: ${level.nodes.map(id => id.replace('component:', '')).join(', ')}`);
      await createStubs(level.nodes);
    }

    // PASS 1: resolve references now that prior levels exist.
    for (const nodeId of level.nodes) {
      resolveReferences(graph.nodes.get(nodeId)!, graph);
    }

    // PASS 2: upsert.
    for (const nodeId of level.nodes) {
      const node = graph.nodes.get(nodeId)!;
      const isCreate = !preExisting.has(node.id);
      try {
        if (dryRun) {
          node.targetData = node.targetData ?? { resource: { ...node.sourceData }, id: node.sourceData.id };
          logger.info(`[dry-run] would ${isCreate ? 'create' : 'update'} ${resourceLabel[node.type]} "${node.name}"`);
        }
        else {
          const result = await upsertNode(node);
          node.targetData = result;
        }
        if (isCreate) { counts.created += 1; }
        else { counts.updated += 1; }
        if (node.type === 'component') { successfulComponentNames.add(node.name); }
      }
      catch (maybeError) {
        counts.failed += 1;
        if (node.type === 'component') { failedComponentNames.add(node.name); }
        logger.warning(`Failed to ${isCreate ? 'create' : 'update'} ${resourceLabel[node.type]} "${node.name}": ${toError(maybeError).message}`);
      }
    }
  };

  const levels = determineProcessingOrder(graph);
  for (const level of levels) {
    await processLevel(level);
  }

  if (prunePresets) {
    await pruneStalePresets({ client, spaceId, targetPresets, localPresetKeys, successfulComponentNames, dryRun, logger, counts });
  }

  return { counts, successfulComponentNames, failedComponentNames };
}

async function pruneStalePresets({
  client,
  spaceId,
  targetPresets,
  localPresetKeys,
  successfulComponentNames,
  dryRun,
  logger,
  counts,
}: {
  client: SyncClient;
  spaceId: number;
  targetPresets: TargetComponentsState['presets'];
  localPresetKeys: Set<string>;
  successfulComponentNames: Set<string>;
  dryRun: boolean;
  logger: Logger;
  counts: ResourceCounts;
}): Promise<void> {
  for (const [compositeKey, targetPreset] of targetPresets) {
    const componentName = compositeKey.slice(0, compositeKey.indexOf(':'));
    if (!successfulComponentNames.has(componentName) || localPresetKeys.has(compositeKey)) {
      continue;
    }
    try {
      if (dryRun) {
        logger.info(`[dry-run] would delete stale preset "${compositeKey}"`);
      }
      else {
        unwrap(await client.presets.delete(targetPreset.id, { path: { space_id: spaceId } }), `presets.delete(${targetPreset.id})`);
        logger.info(`Deleted stale preset "${compositeKey}"`);
      }
    }
    catch (maybeError) {
      counts.failed += 1;
      logger.warning(`Failed to delete stale preset "${compositeKey}": ${toError(maybeError).message}`);
    }
  }
}
