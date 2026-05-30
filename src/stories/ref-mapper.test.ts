import { describe, expect, it } from 'vitest';
import { storyRefMapper } from './ref-mapper';
import type { AssetMap, ComponentSchemas, Story, StoryMap } from '../types';

const schemas: ComponentSchemas = {
  page: {
    asset: { type: 'asset' },
    gallery: { type: 'multiasset' },
    link: { type: 'multilink' },
    refs: { type: 'options', source: 'internal_stories' },
    body: { type: 'bloks' },
    rich: { type: 'richtext' },
  },
  nested: {
    asset: { type: 'asset' },
  },
} as unknown as ComponentSchemas;

const makeStory = (content: any): Story => ({
  id: 1,
  uuid: 'dev-uuid',
  parent_id: 5,
  name: 'Page',
  slug: 'page',
  full_slug: 'en/page',
  is_folder: false,
  alternates: [{ id: 90, parent_id: 91, name: 'alt', slug: 'alt', published: true, full_slug: 'de/page', is_folder: false }],
  content,
} as unknown as Story);

describe('storyRefMapper', () => {
  it('maps story-level id / uuid / parent_id / alternates', () => {
    const stories: StoryMap = new Map();
    stories.set(1, 1000);
    stories.set('dev-uuid', 'prod-uuid');
    stories.set(5, 1100);
    stories.set(90, 9000);
    stories.set(91, 9100);

    const mapped = storyRefMapper(makeStory({ _uid: 'x', component: 'page' }), { schemas, maps: { stories, assets: new Map() } });

    expect(mapped.id).toBe(1000);
    expect(mapped.uuid).toBe('prod-uuid');
    expect(mapped.parent_id).toBe(1100);
    expect(mapped.alternates?.[0].id).toBe(9000);
    expect(mapped.alternates?.[0].parent_id).toBe(9100);
  });

  it('maps asset / multiasset and normalizes S3 → CDN, preserving meta_data', () => {
    const assets: AssetMap = new Map();
    assets.set(10, { old: {} as any, new: { id: 500, filename: 'https://s3.amazonaws.com/a.storyblok.com/f/1/a.png', meta_data: { alt: 'New' } } as any });
    assets.set(11, { old: {} as any, new: { id: 501, filename: 'https://a.storyblok.com/f/1/b.png' } as any });

    const mapped = storyRefMapper(makeStory({
      _uid: 'x',
      component: 'page',
      asset: { fieldtype: 'asset', id: 10, filename: 'old' },
      gallery: [{ fieldtype: 'asset', id: 11, filename: 'old' }],
    }), { schemas, maps: { stories: new Map(), assets } });

    expect((mapped.content as any).asset.id).toBe(500);
    expect((mapped.content as any).asset.filename).toBe('https://a.storyblok.com/f/1/a.png');
    expect((mapped.content as any).asset.meta_data.alt).toBe('New');
    expect((mapped.content as any).gallery[0].id).toBe(501);
  });

  it('maps multilink (story) ids and options internal_stories ids', () => {
    const stories: StoryMap = new Map([[20, 2000], [30, 3000], [31, 3100]]);
    const mapped = storyRefMapper(makeStory({
      _uid: 'x',
      component: 'page',
      link: { linktype: 'story', id: 20 },
      refs: [30, 31],
    }), { schemas, maps: { stories, assets: new Map() } });

    expect((mapped.content as any).link.id).toBe(2000);
    expect((mapped.content as any).refs).toEqual([3000, 3100]);
  });

  it('recurses into bloks and richtext (story-link uuid + embedded blok asset)', () => {
    const stories: StoryMap = new Map([['link-uuid', 'prod-link-uuid']]);
    const assets: AssetMap = new Map([[12, { old: {} as any, new: { id: 600, filename: 'https://a.storyblok.com/f/1/c.png' } as any }]]);

    const mapped = storyRefMapper(makeStory({
      _uid: 'x',
      component: 'page',
      body: [{ _uid: 'b', component: 'nested', asset: { fieldtype: 'asset', id: 12, filename: 'old' } }],
      rich: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { linktype: 'story', uuid: 'link-uuid' } }] }] },
          { type: 'blok', attrs: { body: [{ _uid: 'c', component: 'nested', asset: { fieldtype: 'asset', id: 12, filename: 'old' } }] } },
        ],
      },
    }), { schemas, maps: { stories, assets } });

    expect((mapped.content as any).body[0].asset.id).toBe(600);
    expect((mapped.content as any).rich.content[0].content[0].marks[0].attrs.uuid).toBe('prod-link-uuid');
    expect((mapped.content as any).rich.content[1].attrs.body[0].asset.id).toBe(600);
  });

  it('handles __i18n__ suffixed fields via the base field schema', () => {
    const assets: AssetMap = new Map([[13, { old: {} as any, new: { id: 700, filename: 'https://a.storyblok.com/f/1/d.png' } as any }]]);
    const mapped = storyRefMapper(makeStory({
      _uid: 'x',
      component: 'page',
      asset__i18n__de: { fieldtype: 'asset', id: 13, filename: 'old' },
    }), { schemas, maps: { stories: new Map(), assets } });

    expect((mapped.content as any).asset__i18n__de.id).toBe(700);
  });

  it('falls back to parent_id 0 for root stories and leaves unmapped refs unchanged', () => {
    const story = { id: 2, uuid: 'u', parent_id: null, name: 'r', slug: 'r', content: { _uid: 'x', component: 'page' } } as unknown as Story;
    const mapped = storyRefMapper(story, { schemas, maps: { stories: new Map(), assets: new Map() } });
    expect(mapped.parent_id).toBe(0);
    expect(mapped.id).toBe(2);
  });

  it('leaves content without a component untouched', () => {
    const story = { id: 3, uuid: 'u3', parent_id: 0, content: { _uid: 'x' } } as unknown as Story;
    const mapped = storyRefMapper(story, { schemas, maps: { stories: new Map(), assets: new Map() } });
    expect(mapped.content).toEqual({ _uid: 'x' });
  });

  it('throws helpful errors for non-array bloks / multiasset', () => {
    const story = makeStory({ _uid: 'x', component: 'page', body: 'nope' });
    expect(() => storyRefMapper(story, { schemas, maps: { stories: new Map(), assets: new Map() } }))
      .toThrow('Invalid bloks field: expected an array');

    const story2 = makeStory({ _uid: 'x', component: 'page', gallery: { id: 1 } });
    expect(() => storyRefMapper(story2, { schemas, maps: { stories: new Map(), assets: new Map() } }))
      .toThrow('Invalid multiasset field: expected an array');
  });
});
