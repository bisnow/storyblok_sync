/**
 * Pure reference remappers for component-graph nodes — ported from the node
 * `resolveReferences` methods in the monoblok CLI. Each rewrites a node's
 * source data so its references point at the prod (target) resources already
 * upserted in earlier levels:
 *
 *   - group:     `parent_id` → target parent group id
 *   - component: `component_group_uuid` → target uuid; `internal_tag_ids` →
 *                target ids (unknown ids preserved); `preset_id` → target id;
 *                schema `component_group_whitelist` → target uuids,
 *                `component_tag_whitelist` → target ids
 *                (`component_whitelist` is names — untouched;
 *                `datasource_slug` is untouched — must pre-exist in prod)
 *   - preset:    `component_id` → target component id
 *
 * Mutates and returns `node.sourceData`. Pure aside from that local mutation.
 */
import type { DependencyGraph, GraphNode } from './graph';

const fieldTypesWithDependencies = ['bloks', 'richtext'] as const;

/** Resolves a node's references against already-upserted target resources. */
export function resolveReferences(node: GraphNode, graph: DependencyGraph): void {
  switch (node.type) {
    case 'tag':
      return; // tags have no references
    case 'group':
      resolveGroupReferences(node, graph);
      return;
    case 'component':
      resolveComponentReferences(node, graph);
      return;
    case 'preset':
      resolvePresetReferences(node, graph);
  }
}

function resolveGroupReferences(node: GraphNode, graph: DependencyGraph): void {
  const group = node.sourceData;
  if (group.parent_uuid) {
    const parentNode = graph.nodes.get(`group:${group.parent_uuid}`);
    if (parentNode?.targetData) {
      node.sourceData = { ...group, parent_id: parentNode.targetData.id as number };
    }
  }
}

function resolveComponentReferences(node: GraphNode, graph: DependencyGraph): void {
  const updated = { ...node.sourceData };

  if (node.sourceData.component_group_uuid) {
    const groupNode = graph.nodes.get(`group:${node.sourceData.component_group_uuid}`);
    if (groupNode?.targetData) {
      updated.component_group_uuid = groupNode.targetData.resource.uuid;
    }
  }

  if (Array.isArray(node.sourceData.internal_tag_ids) && node.sourceData.internal_tag_ids.length > 0) {
    updated.internal_tag_ids = node.sourceData.internal_tag_ids.map((tagId: string | number) => {
      const tagNode = graph.nodes.get(`tag:${tagId}`);
      // Keep the original id when the tag already exists only in the target.
      return tagNode?.targetData ? String(tagNode.targetData.id) : String(tagId);
    });
  }

  if (node.sourceData.preset_id) {
    const presetNode = findPresetNodeBySourceId(node.sourceData.preset_id, graph);
    if (presetNode?.targetData) {
      updated.preset_id = presetNode.targetData.id as number;
    }
  }

  if (node.sourceData.schema) {
    updated.schema = resolveSchemaReferences(node.sourceData.schema, graph);
  }

  node.sourceData = updated;
}

function resolvePresetReferences(node: GraphNode, graph: DependencyGraph): void {
  const componentNode = findComponentNodeBySourceId(node.sourceData.component_id, graph);
  if (componentNode?.targetData) {
    node.sourceData = { ...node.sourceData, component_id: componentNode.targetData.id as number };
  }
}

function findPresetNodeBySourceId(presetId: number, graph: DependencyGraph): GraphNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.type === 'preset' && node.sourceData.id === presetId) { return node; }
  }
  return undefined;
}

function findComponentNodeBySourceId(componentId: number, graph: DependencyGraph): GraphNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.type === 'component' && node.sourceData.id === componentId) { return node; }
  }
  return undefined;
}

/** Deep-copies a schema and remaps group/tag whitelist references to target ids. */
export function resolveSchemaReferences(schema: Record<string, any>, graph: DependencyGraph): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(schema));

  const resolveField = (field: any): any => {
    if (typeof field !== 'object' || field === null) { return field; }
    if (Array.isArray(field)) { return field.map(resolveField); }

    const resolved = { ...field };

    if ((fieldTypesWithDependencies as readonly string[]).includes(resolved.type)) {
      if (Array.isArray(resolved.component_group_whitelist)) {
        resolved.component_group_whitelist = resolved.component_group_whitelist.map((groupUuid: string) => {
          const groupNode = graph.nodes.get(`group:${groupUuid}`);
          return groupNode?.targetData?.resource.uuid || groupUuid;
        });
      }
      if (Array.isArray(resolved.component_tag_whitelist)) {
        resolved.component_tag_whitelist = resolved.component_tag_whitelist.map((tagId: number) => {
          const tagNode = graph.nodes.get(`tag:${tagId}`);
          return tagNode?.targetData?.id ?? tagId;
        });
      }
      // component_whitelist uses names — no remap. datasource_slug untouched.
    }

    for (const key of Object.keys(resolved)) {
      if (typeof resolved[key] === 'object' && resolved[key] !== null) {
        resolved[key] = resolveField(resolved[key]);
      }
    }
    return resolved;
  };

  const result: Record<string, any> = {};
  for (const key of Object.keys(copy)) {
    result[key] = resolveField(copy[key]);
  }
  return result;
}
