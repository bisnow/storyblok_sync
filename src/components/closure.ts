/**
 * Dependency closure for a named subset of components — ported from the CLI's
 * `components/push/utils.ts` (`collectAllDependencies` /
 * `filterSpaceDataByComponent`), generalised to take a list of names.
 *
 * Given the components the developer named, pulls in everything required to push
 * them correctly: their groups (and parent groups), tags, whitelisted
 * components (recursively), and their presets. Pure.
 */
import type { Component, ComponentFolder, InternalTag } from '../types';
import { collectWhitelistDependencies, type SpaceComponentsData } from './graph';

function collectAllDependencies(
  seedComponents: Component[],
  allComponents: Component[],
  allGroups: ComponentFolder[],
  allTags: InternalTag[],
): { filteredComponents: Component[]; filteredGroups: ComponentFolder[]; filteredTags: InternalTag[] } {
  const requiredComponents = new Set<string>();
  const requiredGroupUuids = new Set<string>();
  const requiredTagIds = new Set<number>();

  seedComponents.forEach(component => requiredComponents.add(component.name));

  function collectComponentDeps(componentName: string, visited = new Set<string>()): void {
    if (visited.has(componentName)) { return; }
    visited.add(componentName);

    const component = allComponents.find(c => c.name === componentName);
    if (!component) { return; }

    if (component.component_group_uuid) {
      requiredGroupUuids.add(component.component_group_uuid);
    }

    if (component.internal_tag_ids && component.internal_tag_ids.length > 0) {
      component.internal_tag_ids.forEach((tagId) => {
        const numericTagId = typeof tagId === 'string' ? Number.parseInt(tagId, 10) : tagId;
        if (!Number.isNaN(numericTagId)) { requiredTagIds.add(numericTagId); }
      });
    }

    if (component.schema) {
      const schemaDeps = collectWhitelistDependencies(component.schema as Record<string, any>);
      schemaDeps.groupUuids.forEach(uuid => requiredGroupUuids.add(uuid));
      schemaDeps.tagIds.forEach(tagId => requiredTagIds.add(tagId));
      schemaDeps.componentNames.forEach((name) => {
        if (!requiredComponents.has(name)) {
          requiredComponents.add(name);
          collectComponentDeps(name, visited);
        }
      });
    }
  }

  seedComponents.forEach(component => collectComponentDeps(component.name));

  function collectParentGroups(groupUuid: string, visited = new Set<string>()): void {
    if (visited.has(groupUuid)) { return; }
    visited.add(groupUuid);
    const group = allGroups.find(g => g.uuid === groupUuid);
    if (group && group.parent_uuid) {
      requiredGroupUuids.add(group.parent_uuid);
      collectParentGroups(group.parent_uuid, visited);
    }
  }

  Array.from(requiredGroupUuids).forEach(groupUuid => collectParentGroups(groupUuid));

  return {
    filteredComponents: allComponents.filter(component => requiredComponents.has(component.name)),
    filteredGroups: allGroups.filter(group => group.uuid !== undefined && requiredGroupUuids.has(group.uuid)),
    filteredTags: allTags.filter(tag => tag.id !== undefined && requiredTagIds.has(tag.id)),
  };
}

/**
 * Returns the closure (named components + every transitive dependency + their
 * presets) drawn from the full dev space data. Unknown names are ignored.
 */
export function collectDependencyClosure(
  names: string[],
  all: SpaceComponentsData,
): SpaceComponentsData {
  const seed = all.components.filter(component => names.includes(component.name));
  if (seed.length === 0) {
    return { components: [], groups: [], presets: [], internalTags: [] };
  }

  const { filteredComponents, filteredGroups, filteredTags } = collectAllDependencies(
    seed,
    all.components,
    all.groups,
    all.internalTags,
  );

  const componentIds = new Set(filteredComponents.map(component => component.id));
  const filteredPresets = all.presets.filter(preset => componentIds.has(preset.component_id));

  return {
    components: filteredComponents,
    groups: filteredGroups,
    presets: filteredPresets,
    internalTags: filteredTags,
  };
}
