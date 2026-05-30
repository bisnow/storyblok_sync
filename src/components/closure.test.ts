import { describe, expect, it } from 'vitest';
import { collectDependencyClosure } from './closure';
import type { SpaceComponentsData } from './graph';

const all: SpaceComponentsData = {
  components: [
    {
      id: 1,
      name: 'a',
      component_group_uuid: 'g-child',
      internal_tag_ids: ['10'],
      schema: {
        body: { type: 'bloks', component_whitelist: ['b'], component_group_whitelist: ['g-other'], component_tag_whitelist: [11] },
      },
    } as any,
    { id: 2, name: 'b', schema: {} } as any,
    { id: 3, name: 'c', schema: {} } as any,
  ],
  groups: [
    { id: 11, uuid: 'g-child', name: 'child', parent_uuid: 'g-parent', parent_id: 12 } as any,
    { id: 12, uuid: 'g-parent', name: 'parent' } as any,
    { id: 13, uuid: 'g-other', name: 'other' } as any,
    { id: 14, uuid: 'g-unrelated', name: 'unrelated' } as any,
  ],
  internalTags: [
    { id: 10, name: 't10' } as any,
    { id: 11, name: 't11' } as any,
    { id: 12, name: 't12' } as any,
  ],
  presets: [
    { id: 100, name: 'p-a', component_id: 1 } as any,
    { id: 101, name: 'p-c', component_id: 3 } as any,
  ],
};

describe('collectDependencyClosure', () => {
  it('pulls in whitelisted components, the group + parent groups, tags and presets', () => {
    const closure = collectDependencyClosure(['a'], all);

    expect(closure.components.map(c => c.name).sort()).toEqual(['a', 'b']);
    expect(closure.groups.map(g => g.uuid).sort()).toEqual(['g-child', 'g-other', 'g-parent']);
    expect(closure.internalTags.map(t => t.id).sort()).toEqual([10, 11]);
    expect(closure.presets.map(p => p.id)).toEqual([100]);
  });

  it('returns an empty closure for an unknown component', () => {
    expect(collectDependencyClosure(['missing'], all)).toEqual({ components: [], groups: [], presets: [], internalTags: [] });
  });
});
