import { describe, expect, it } from 'vitest';
import { buildDependencyGraph, determineProcessingOrder, type SpaceComponentsData, type TargetComponentsState } from './graph';

const emptyTarget = (): TargetComponentsState => ({ components: new Map(), groups: new Map(), tags: new Map(), presets: new Map() });

describe('determineProcessingOrder', () => {
  it('orders tags → groups → components → presets', () => {
    const local: SpaceComponentsData = {
      components: [{ id: 1, name: 'a', component_group_uuid: 'g1', internal_tag_ids: ['10'], schema: {} } as any],
      groups: [{ id: 5, uuid: 'g1', name: 'grp' } as any],
      internalTags: [{ id: 10, name: 't' } as any],
      presets: [{ id: 100, name: 'p', component_id: 1 } as any],
    };
    const graph = buildDependencyGraph(local, emptyTarget());
    const levels = determineProcessingOrder(graph);

    const typeAt = (i: number) => levels[i].nodes.map(id => id.split(':')[0]).sort();
    expect(typeAt(0)).toEqual(['group', 'tag']);
    expect(typeAt(1)).toEqual(['component']);
    expect(typeAt(2)).toEqual(['preset']);
    expect(levels.every(l => !l.isCyclic)).toBe(true);
  });

  it('emits a cyclic level for component-only whitelist cycles', () => {
    const local: SpaceComponentsData = {
      components: [
        { id: 1, name: 'a', schema: { body: { type: 'bloks', component_whitelist: ['b'] } } } as any,
        { id: 2, name: 'b', schema: { body: { type: 'bloks', component_whitelist: ['a'] } } } as any,
      ],
      groups: [],
      internalTags: [],
      presets: [],
    };
    const levels = determineProcessingOrder(buildDependencyGraph(local, emptyTarget()));
    const cyclic = levels.find(l => l.isCyclic);
    expect(cyclic).toBeDefined();
    expect(cyclic!.nodes.sort()).toEqual(['component:a', 'component:b']);
  });

  it('throws on a circular group hierarchy', () => {
    const local: SpaceComponentsData = {
      components: [],
      groups: [
        { id: 1, uuid: 'g1', name: 'g1', parent_uuid: 'g2', parent_id: 2 } as any,
        { id: 2, uuid: 'g2', name: 'g2', parent_uuid: 'g1', parent_id: 1 } as any,
      ],
      internalTags: [],
      presets: [],
    };
    expect(() => determineProcessingOrder(buildDependencyGraph(local, emptyTarget())))
      .toThrow('Unsupported circular dependency');
  });
});
