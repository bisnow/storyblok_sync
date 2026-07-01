/**
 * Pulls component-related state from a space and builds the lookups the rest of
 * the action needs:
 *   - `fetchAllComponentsData` → the full dev set (components/groups/presets/tags)
 *   - `buildSchemas` → name→schema map (needed by story validation + ref-mapping)
 *   - `fetchTargetState` → prod resources indexed by natural key for upsert
 */
import type { Component, ComponentFolder, InternalTag, Preset, SyncClient } from '../types';
import type { ComponentSchemas } from '../types';
import { listAll } from '../lib/paginate';
import { unwrap } from '../lib/result';
import type { SpaceComponentsData, TargetComponentsState } from './graph';

/** Lists every component/group/preset/tag in a space. */
export async function fetchAllComponentsData(client: SyncClient, spaceId: number): Promise<SpaceComponentsData> {
  const [components, groups, presets, internalTags] = await Promise.all([
    listAll(
      page => client.components.list({ path: { space_id: spaceId }, query: { page, per_page: 100 } }),
      (data: any) => (data.components ?? []) as Component[],
      'components.list',
    ),
    (async () => {
      const data = unwrap(await client.componentFolders.list({ path: { space_id: spaceId } }), 'componentFolders.list') as any;
      return (data.component_groups ?? []) as ComponentFolder[];
    })(),
    (async () => {
      const data = unwrap(await client.presets.list({ path: { space_id: spaceId } }), 'presets.list') as any;
      return (data.presets ?? []) as Preset[];
    })(),
    listAll(
      page => client.internalTags.list({ path: { space_id: spaceId }, query: { page, per_page: 100, by_object_type: 'component' } }),
      (data: any) => (data.internal_tags ?? []) as InternalTag[],
      'internalTags.list',
    ),
  ]);

  return { components, groups, presets, internalTags };
}

/** Builds the name→schema lookup from a component list. */
export function buildSchemas(components: Component[]): ComponentSchemas {
  const schemas: ComponentSchemas = {};
  for (const component of components) {
    schemas[component.name] = component.schema;
  }
  return schemas;
}

/** Indexes a space's component resources by natural key for upsert decisions. */
export function indexTargetState(data: SpaceComponentsData): TargetComponentsState {
  const components = new Map<string, Component>();
  const groups = new Map<string, ComponentFolder>();
  const tags = new Map<string, InternalTag>();
  const presets = new Map<string, Preset>();

  for (const component of data.components) { components.set(component.name, component); }
  for (const group of data.groups) { groups.set(group.name, group); }
  for (const tag of data.internalTags) { tags.set(tag.name, tag); }

  const componentById = new Map(data.components.map(c => [c.id, c]));
  for (const preset of data.presets) {
    const component = componentById.get(preset.component_id);
    if (component) {
      presets.set(`${component.name}:${preset.name}`, preset);
    }
  }

  return { components, groups, tags, presets };
}

/** Fetches and indexes the prod component state. */
export async function fetchTargetState(client: SyncClient, spaceId: number): Promise<{ raw: SpaceComponentsData; indexed: TargetComponentsState }> {
  const raw = await fetchAllComponentsData(client, spaceId);
  return { raw, indexed: indexTargetState(raw) };
}
