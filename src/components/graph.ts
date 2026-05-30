/**
 * Component dependency graph — ported from the monoblok CLI's
 * `graph-operations/dependency-graph.ts`, restructured to use plain node objects
 * (no I/O-bearing class methods). The graph models tags, groups, components and
 * presets and the references between them so `determineProcessingOrder` can emit
 * dependency-ordered levels (effective order: tags → groups → components →
 * presets). Reference resolution and upsert live in `remap.ts` / `push.ts`.
 *
 * Pure: building and ordering touch no network or filesystem.
 */
import type { Component, ComponentFolder, InternalTag, Preset } from '../types';

export type NodeType = 'component' | 'group' | 'tag' | 'preset';

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  sourceData: any;
  targetData?: { resource: any; id: number };
  dependencies: Set<string>;
  dependents: Set<string>;
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
}

export interface SpaceComponentsData {
  components: Component[];
  groups: ComponentFolder[];
  presets: Preset[];
  internalTags: InternalTag[];
}

export interface TargetComponentsState {
  components: Map<string, Component>;
  groups: Map<string, ComponentFolder>;
  tags: Map<string, InternalTag>;
  presets: Map<string, Preset>;
}

export interface SchemaDependencies {
  groupUuids: Set<string>;
  tagIds: Set<number>;
  componentNames: Set<string>;
  datasourceNames: Set<string>;
}

/** Processing level emitted by `determineProcessingOrder`. */
export interface ProcessingLevel {
  nodes: string[];
  isCyclic: boolean;
}

const fieldTypesWithDependencies = ['bloks', 'richtext'] as const;

const makeNode = (
  id: string,
  type: NodeType,
  name: string,
  sourceData: any,
  targetResource?: any,
): GraphNode => ({
  id,
  type,
  name,
  sourceData,
  targetData: targetResource ? { resource: targetResource, id: targetResource.id } : undefined,
  dependencies: new Set<string>(),
  dependents: new Set<string>(),
});

/**
 * Extracts group/tag/component/datasource references from a component schema's
 * `bloks`/`richtext` whitelists (recursively). Ported verbatim.
 */
export function collectWhitelistDependencies(schema: Record<string, any>): SchemaDependencies {
  const groupUuids = new Set<string>();
  const tagIds = new Set<number>();
  const componentNames = new Set<string>();
  const datasourceNames = new Set<string>();

  function traverseField(field: Record<string, any>) {
    if ((fieldTypesWithDependencies as readonly string[]).includes(field.type)) {
      if (Array.isArray(field.component_group_whitelist)) {
        field.component_group_whitelist.forEach((uuid: string) => groupUuids.add(uuid));
      }
      if (Array.isArray(field.component_tag_whitelist)) {
        field.component_tag_whitelist.forEach((tagId: number) => tagIds.add(tagId));
      }
      if (Array.isArray(field.component_whitelist)) {
        field.component_whitelist.forEach((name: string) => componentNames.add(name));
      }
    }

    if ((field.type === 'option' || field.type === 'options') && field.source === 'internal') {
      if (typeof field.datasource_slug === 'string') {
        datasourceNames.add(field.datasource_slug);
      }
    }

    Object.values(field).forEach((value) => {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (typeof item === 'object' && item !== null) { traverseField(item); }
        });
      }
      else if (typeof value === 'object' && value !== null) {
        traverseField(value);
      }
    });
  }

  Object.values(schema).forEach((field) => {
    if (typeof field === 'object' && field !== null) { traverseField(field); }
  });

  return { groupUuids, tagIds, componentNames, datasourceNames };
}

/**
 * Builds the dependency graph from local data with prod (target) resources
 * colocated on each node, indexed by natural key. Ported from the CLI.
 */
export function buildDependencyGraph(
  local: SpaceComponentsData,
  target: TargetComponentsState,
  onWarn: (message: string) => void = () => {},
): DependencyGraph {
  const graph: DependencyGraph = { nodes: new Map() };

  const addDependency = (dependentId: string, dependencyId: string) => {
    const dependent = graph.nodes.get(dependentId);
    const dependency = graph.nodes.get(dependencyId);
    if (dependent && dependency) {
      dependent.dependencies.add(dependencyId);
      dependency.dependents.add(dependentId);
    }
  };

  for (const tag of local.internalTags) {
    graph.nodes.set(`tag:${tag.id}`, makeNode(`tag:${tag.id}`, 'tag', tag.name, tag, target.tags.get(tag.name)));
  }
  for (const group of local.groups) {
    graph.nodes.set(`group:${group.uuid}`, makeNode(`group:${group.uuid}`, 'group', group.name, group, target.groups.get(group.name)));
  }
  for (const component of local.components) {
    graph.nodes.set(`component:${component.name}`, makeNode(`component:${component.name}`, 'component', component.name, component, target.components.get(component.name)));
  }

  const componentById = new Map(local.components.map(c => [c.id, c]));
  for (const preset of local.presets) {
    const sourceComponent = componentById.get(preset.component_id);
    if (!sourceComponent) {
      onWarn(`Preset "${preset.name}" (id ${preset.id}) references component id ${preset.component_id} which is not in the synced set. Skipping preset.`);
      continue;
    }
    const compositeKey = `${sourceComponent.name}:${preset.name}`;
    const targetPreset = target.presets.get(compositeKey);
    graph.nodes.set(`preset:${preset.id}`, makeNode(`preset:${preset.id}`, 'preset', preset.name, preset, targetPreset));
  }

  // Group parent edges
  for (const group of local.groups) {
    if (group.parent_uuid && group.parent_id && group.parent_uuid !== group.uuid) {
      addDependency(`group:${group.uuid}`, `group:${group.parent_uuid}`);
    }
  }

  // Component edges
  for (const component of local.components) {
    const componentId = `component:${component.name}`;
    for (const tagId of component.internal_tag_ids ?? []) {
      addDependency(componentId, `tag:${tagId}`);
    }
    if (component.component_group_uuid) {
      addDependency(componentId, `group:${component.component_group_uuid}`);
    }
    if (component.preset_id) {
      const preset = local.presets.find(p => p.id === component.preset_id);
      if (preset) { addDependency(componentId, `preset:${preset.id}`); }
    }
    if (component.schema) {
      const deps = collectWhitelistDependencies(component.schema as Record<string, any>);
      deps.groupUuids.forEach(uuid => addDependency(componentId, `group:${uuid}`));
      deps.tagIds.forEach(tagId => addDependency(componentId, `tag:${tagId}`));
      deps.componentNames.forEach(name => addDependency(componentId, `component:${name}`));
    }
  }

  // Preset → component edges
  for (const preset of local.presets) {
    const component = local.components.find(c => c.id === preset.component_id);
    if (component) {
      addDependency(`preset:${preset.id}`, `component:${component.name}`);
    }
  }

  return graph;
}

/** Tarjan's algorithm — returns the strongly-connected components. Ported. */
export function detectStronglyConnectedComponents(nodeIds: string[], graph: DependencyGraph): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let currentIndex = 0;
  const nodeIdSet = new Set(nodeIds);

  function strongConnect(nodeId: string) {
    index.set(nodeId, currentIndex);
    lowLink.set(nodeId, currentIndex);
    currentIndex++;
    stack.push(nodeId);
    onStack.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node) {
      for (const dependencyId of node.dependencies) {
        if (nodeIdSet.has(dependencyId)) {
          if (!index.has(dependencyId)) {
            strongConnect(dependencyId);
            lowLink.set(nodeId, Math.min(lowLink.get(nodeId)!, lowLink.get(dependencyId)!));
          }
          else if (onStack.has(dependencyId)) {
            lowLink.set(nodeId, Math.min(lowLink.get(nodeId)!, index.get(dependencyId)!));
          }
        }
      }
    }

    if (lowLink.get(nodeId) === index.get(nodeId)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== nodeId);
      sccs.push(scc);
    }
  }

  for (const nodeId of nodeIds) {
    if (!index.has(nodeId)) { strongConnect(nodeId); }
  }

  return sccs;
}

/** Detects component-only circular whitelists (allowed; handled via stubs). Ported. */
export function detectCircularWhitelists(graph: DependencyGraph): string[] {
  const circular: string[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(nodeId: string, path: string[]): boolean {
    if (recursionStack.has(nodeId)) {
      const cycle = path.slice(path.indexOf(nodeId)).concat(nodeId);
      if (cycle.every(id => id.startsWith('component:'))) { circular.push(cycle.join(' → ')); }
      return true;
    }
    if (visited.has(nodeId)) { return false; }
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);
    const node = graph.nodes.get(nodeId);
    if (node) {
      for (const dependencyId of node.dependencies) {
        if (dfs(dependencyId, [...path])) { return true; }
      }
    }
    recursionStack.delete(nodeId);
    path.pop();
    return false;
  }

  for (const nodeId of graph.nodes.keys()) {
    if (nodeId.startsWith('component:') && !visited.has(nodeId)) { dfs(nodeId, []); }
  }
  return circular;
}

/**
 * Topological sort with SCC handling. Emits dependency levels; component-only
 * cycles become cyclic levels (resolved with stub-create in push.ts). Cycles
 * involving groups/tags/presets throw. Ported.
 */
export function determineProcessingOrder(graph: DependencyGraph): ProcessingLevel[] {
  const levels: ProcessingLevel[] = [];
  const inDegree = new Map<string, number>();

  for (const [nodeId, node] of graph.nodes) {
    inDegree.set(nodeId, node.dependencies.size);
  }

  while (inDegree.size > 0) {
    const currentLevel: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) { currentLevel.push(nodeId); }
    }

    if (currentLevel.length === 0) {
      const remainingNodes = Array.from(inDegree.keys());
      const sccs = detectStronglyConnectedComponents(remainingNodes, graph);
      for (const scc of sccs) {
        const hasNonComponent = scc.some(nodeId => nodeId.startsWith('group:') || nodeId.startsWith('tag:') || nodeId.startsWith('preset:'));
        if (hasNonComponent) {
          throw new Error(`Unsupported circular dependency involving groups, tags, or presets: ${scc.join(' → ')}`);
        }
        levels.push({ nodes: scc, isCyclic: true });
        scc.forEach(nodeId => inDegree.delete(nodeId));
      }
      continue;
    }

    levels.push({ nodes: currentLevel, isCyclic: false });
    for (const nodeId of currentLevel) {
      inDegree.delete(nodeId);
      const node = graph.nodes.get(nodeId)!;
      for (const dependentId of node.dependents) {
        const currentDegree = inDegree.get(dependentId);
        if (currentDegree !== undefined) { inDegree.set(dependentId, currentDegree - 1); }
      }
    }
  }

  return levels;
}
