import { describe, expect, it } from 'vitest';
import { bridgeStoryLinks, collectStoryLinkReferences, type StoryLinkRef } from './link-bridge';
import type { ComponentSchemas, Story, StoryMap } from '../types';

const schemas: ComponentSchemas = {
  page: {
    link: { type: 'multilink' },
    refs: { type: 'options', source: 'internal_stories' },
    body: { type: 'bloks' },
    rich: { type: 'richtext' },
  },
  card: { link: { type: 'multilink' } },
} as unknown as ComponentSchemas;

describe('collectStoryLinkReferences', () => {
  it('collects multilink ids, options ids, richtext-link uuids and nested blok links', () => {
    const story = {
      content: {
        _uid: 'x',
        component: 'page',
        link: { linktype: 'story', id: 20, uuid: 'u20' },
        refs: [30, 31],
        body: [{ _uid: 'b', component: 'card', link: { linktype: 'story', id: 40 } }],
        rich: {
          type: 'doc',
          content: [
            { type: 'text', marks: [{ type: 'link', attrs: { linktype: 'story', uuid: 'rt-uuid' } }] },
            { type: 'blok', attrs: { body: [{ _uid: 'c', component: 'card', link: { linktype: 'story', id: 50 } }] } },
          ],
        },
      },
    } as unknown as Story;

    const refs = collectStoryLinkReferences(story, schemas);
    expect(refs).toContainEqual({ id: 20, uuid: 'u20' });
    expect(refs).toContainEqual({ id: 30 });
    expect(refs).toContainEqual({ id: 31 });
    expect(refs).toContainEqual({ id: 40, uuid: undefined });
    expect(refs).toContainEqual({ uuid: 'rt-uuid' });
    expect(refs).toContainEqual({ id: 50, uuid: undefined });
  });

  it('ignores non-story multilinks', () => {
    const story = { content: { _uid: 'x', component: 'page', link: { linktype: 'url', url: 'https://x' } } } as unknown as Story;
    expect(collectStoryLinkReferences(story, schemas)).toEqual([]);
  });
});

describe('bridgeStoryLinks', () => {
  const devSlug: Record<string, string> = { 'u-a': 'en/a', '100': 'en/a', 'u-b': 'en/b' };
  const prodBySlug: Record<string, { id: number; uuid: string }> = {
    'en/a': { id: 1000, uuid: 'prod-a' },
    'en/b': { id: 2000, uuid: 'prod-b' },
  };

  const resolveDevFullSlug = (ref: StoryLinkRef) => devSlug[ref.uuid ?? String(ref.id)];
  const resolveProdBySlug = (slug: string) => prodBySlug[slug];

  it('bridges uuid and id references by slug across spaces', () => {
    const storyMap: StoryMap = new Map();
    const { added, unresolved } = bridgeStoryLinks({
      references: [{ uuid: 'u-a' }, { id: 100 }],
      storyMap,
      resolveDevFullSlug,
      resolveProdBySlug,
    });
    expect(storyMap.get('u-a')).toBe('prod-a');
    expect(storyMap.get(100)).toBe(1000);
    expect(added).toBe(2);
    expect(unresolved).toEqual([]);
  });

  it('skips references already mapped from pass 1', () => {
    const storyMap: StoryMap = new Map([['u-a', 'already']]);
    const { added } = bridgeStoryLinks({ references: [{ uuid: 'u-a' }], storyMap, resolveDevFullSlug, resolveProdBySlug });
    expect(added).toBe(0);
    expect(storyMap.get('u-a')).toBe('already');
  });

  it('warns and leaves unresolved links unchanged', () => {
    const storyMap: StoryMap = new Map();
    const warnings: string[] = [];
    const { unresolved } = bridgeStoryLinks({
      references: [{ uuid: 'u-missing' }],
      storyMap,
      resolveDevFullSlug,
      resolveProdBySlug,
      onWarn: m => warnings.push(m),
    });
    expect(unresolved).toEqual([{ uuid: 'u-missing' }]);
    expect(storyMap.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});
