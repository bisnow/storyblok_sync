import { describe, expect, it } from 'vitest';
import { formatStoryWarnings, validateStoryAgainstSchemas } from './validate';
import type { ComponentSchemas, Story } from '../types';

const schemas: ComponentSchemas = {
  page: { title: { type: 'text' }, body: { type: 'bloks' }, rich: { type: 'richtext' } },
  card: { heading: { type: 'text' } },
} as unknown as ComponentSchemas;

const story = (content: any): Story => ({ id: 1, uuid: 'u', parent_id: 0, slug: 's', full_slug: 'en/s', content } as unknown as Story);

describe('validateStoryAgainstSchemas', () => {
  it('reports a missing component schema and stops descending into it', () => {
    const { missingSchemas, driftByComponent } = validateStoryAgainstSchemas(
      story({ _uid: 'x', component: 'unknown', whatever: { unexpected: true } }),
      schemas,
    );
    expect([...missingSchemas]).toEqual(['unknown']);
    expect(driftByComponent.size).toBe(0);
  });

  it('reports schema drift for fields not declared (ignoring component and _ keys)', () => {
    const { driftByComponent } = validateStoryAgainstSchemas(
      story({ _uid: 'x', _editable: 'm', component: 'page', title: 'ok', subtitle: 'drift' }),
      schemas,
    );
    expect([...(driftByComponent.get('page') ?? [])]).toEqual(['subtitle']);
  });

  it('descends into bloks and richtext-embedded bloks', () => {
    const { missingSchemas } = validateStoryAgainstSchemas(
      story({
        _uid: 'x',
        component: 'page',
        body: [{ _uid: 'b', component: 'card', heading: 'hi' }, { _uid: 'c', component: 'ghost' }],
        rich: { type: 'doc', content: [{ type: 'blok', attrs: { body: [{ _uid: 'd', component: 'phantom' }] } }] },
      }),
      schemas,
    );
    expect([...missingSchemas].sort()).toEqual(['ghost', 'phantom']);
  });

  it('treats __i18n__ fields as their base field', () => {
    const { driftByComponent } = validateStoryAgainstSchemas(
      story({ _uid: 'x', component: 'page', title__i18n__de: 'Titel' }),
      schemas,
    );
    expect(driftByComponent.size).toBe(0);
  });

  it('formats warnings for missing schemas and drift', () => {
    const issues = validateStoryAgainstSchemas(
      story({ _uid: 'x', component: 'page', extra: 1, nested: { _uid: 'n', component: 'unknown' } }),
      schemas,
    );
    // `nested` is drift (not a bloks/richtext field) so 'unknown' is not descended.
    const warnings = formatStoryWarnings(story({ _uid: 'x', component: 'page' } as any), issues);
    expect(warnings.some(w => w.includes('not declared in "page"'))).toBe(true);
  });
});
