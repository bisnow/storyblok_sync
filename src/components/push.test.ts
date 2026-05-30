import { describe, expect, it, vi } from 'vitest';
import { pushComponents } from './push';
import { buildDependencyGraph, type SpaceComponentsData, type TargetComponentsState } from './graph';
import { silentLogger } from '../logger';
import type { SyncClient } from '../types';

const ok = (data: any) => ({ data, error: undefined, response: { status: 200, headers: new Headers() }, request: {} });
const err = (status: number) => ({ data: undefined, error: { data: { message: 'boom' } }, response: { status, headers: new Headers() }, request: {} });

const local: SpaceComponentsData = {
  components: [{ id: 1, name: 'a', schema: {} } as any, { id: 2, name: 'b', schema: {} } as any],
  groups: [],
  internalTags: [],
  presets: [],
};

const targetState = (): TargetComponentsState => ({
  components: new Map([['b', { id: 20, name: 'b' } as any]]),
  groups: new Map(),
  tags: new Map(),
  presets: new Map(),
});

const makeProd = () => ({
  components: {
    create: vi.fn(async (opts: any) => ok({ component: { id: 900, name: opts.body.component.name } })),
    update: vi.fn(async (id: number, opts: any) => ok({ component: { id, name: opts.body.component.name } })),
  },
  presets: { delete: vi.fn(async () => ok({})) },
} as unknown as SyncClient);

describe('pushComponents', () => {
  it('creates absent components and updates existing ones', async () => {
    const prod = makeProd();
    const graph = buildDependencyGraph(local, targetState());
    const result = await pushComponents({
      client: prod, spaceId: 99, graph, localPresetKeys: new Set(), targetPresets: new Map(),
      dryRun: false, prunePresets: false, logger: silentLogger,
    });

    expect((prod.components.create as any)).toHaveBeenCalledTimes(1);
    expect((prod.components.create as any).mock.calls[0][0].body.component.name).toBe('a');
    expect((prod.components.update as any)).toHaveBeenCalledWith(20, expect.anything());
    expect(result.counts).toMatchObject({ created: 1, updated: 1, failed: 0 });
    expect([...result.successfulComponentNames].sort()).toEqual(['a', 'b']);
  });

  it('makes no write calls in dry-run but still counts intended work', async () => {
    const prod = makeProd();
    const result = await pushComponents({
      client: prod, spaceId: 99, graph: buildDependencyGraph(local, targetState()), localPresetKeys: new Set(), targetPresets: new Map(),
      dryRun: true, prunePresets: false, logger: silentLogger,
    });
    expect((prod.components.create as any)).not.toHaveBeenCalled();
    expect((prod.components.update as any)).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({ created: 1, updated: 1 });
  });

  it('counts a failed upsert and records the failed component name', async () => {
    const prod = makeProd();
    (prod.components.create as any).mockResolvedValueOnce(err(422));
    const result = await pushComponents({
      client: prod, spaceId: 99, graph: buildDependencyGraph(local, targetState()), localPresetKeys: new Set(), targetPresets: new Map(),
      dryRun: false, prunePresets: false, logger: silentLogger,
    });
    expect(result.counts).toMatchObject({ created: 0, updated: 1, failed: 1 });
    expect([...result.failedComponentNames]).toEqual(['a']);
  });

  it('prunes stale presets of successfully-pushed components', async () => {
    const prod = makeProd();
    const targetPresets = new Map([['b:stale', { id: 700, name: 'stale', component_id: 20 } as any]]);
    await pushComponents({
      client: prod, spaceId: 99, graph: buildDependencyGraph(local, targetState()), localPresetKeys: new Set(), targetPresets,
      dryRun: false, prunePresets: true, logger: silentLogger,
    });
    expect((prod.presets.delete as any)).toHaveBeenCalledWith(700, expect.anything());
  });
});
