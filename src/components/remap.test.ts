import { describe, expect, it } from 'vitest';
import { buildDependencyGraph, type SpaceComponentsData, type TargetComponentsState } from './graph';
import { resolveReferences } from './remap';

const buildGraphWithTargets = () => {
  const local: SpaceComponentsData = {
    components: [
      {
        id: 2,
        name: 'comp',
        component_group_uuid: 'dev-g',
        internal_tag_ids: ['10', '99'],
        preset_id: 100,
        schema: {
          body: {
            type: 'bloks',
            component_group_whitelist: ['dev-g'],
            component_tag_whitelist: [10],
            component_whitelist: ['other'],
            datasource_slug: 'ds',
          },
        },
      } as any,
    ],
    groups: [
      { id: 1, uuid: 'dev-g', name: 'grp' } as any,
      { id: 3, uuid: 'dev-gc', name: 'child', parent_uuid: 'dev-gp', parent_id: 4 } as any,
      { id: 4, uuid: 'dev-gp', name: 'parent' } as any,
    ],
    internalTags: [{ id: 10, name: 't10' } as any],
    presets: [{ id: 100, name: 'pre', component_id: 2 } as any],
  };

  const target: TargetComponentsState = {
    components: new Map([['comp', { id: 800, name: 'comp' } as any]]),
    groups: new Map([
      ['grp', { id: 11, uuid: 'prod-g', name: 'grp' } as any],
      ['parent', { id: 1200, uuid: 'prod-gp', name: 'parent' } as any],
    ]),
    tags: new Map([['t10', { id: 500, name: 't10' } as any]]),
    presets: new Map([['comp:pre', { id: 900, name: 'pre', component_id: 2 } as any]]),
  };

  return buildDependencyGraph(local, target);
};

describe('resolveReferences', () => {
  it('remaps component group uuid, tag ids (unknown preserved), preset id and schema whitelists', () => {
    const graph = buildGraphWithTargets();
    const component = graph.nodes.get('component:comp')!;
    resolveReferences(component, graph);

    expect(component.sourceData.component_group_uuid).toBe('prod-g');
    expect(component.sourceData.internal_tag_ids).toEqual(['500', '99']);
    expect(component.sourceData.preset_id).toBe(900);
    expect(component.sourceData.schema.body.component_group_whitelist).toEqual(['prod-g']);
    expect(component.sourceData.schema.body.component_tag_whitelist).toEqual([500]);
    expect(component.sourceData.schema.body.component_whitelist).toEqual(['other']);
    expect(component.sourceData.schema.body.datasource_slug).toBe('ds');
  });

  it('remaps a preset component_id to the target component id', () => {
    const graph = buildGraphWithTargets();
    const preset = graph.nodes.get('preset:100')!;
    resolveReferences(preset, graph);
    expect(preset.sourceData.component_id).toBe(800);
  });

  it('remaps a group parent_id to the target parent group id', () => {
    const graph = buildGraphWithTargets();
    const child = graph.nodes.get('group:dev-gc')!;
    resolveReferences(child, graph);
    expect(child.sourceData.parent_id).toBe(1200);
  });
});
