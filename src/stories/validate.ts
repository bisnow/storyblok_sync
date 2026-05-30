/**
 * Story content validation against component schemas — ported from the monoblok
 * CLI's `validate-story.ts` (the pure `validateStoryAgainstSchemas`; the
 * stream/filesystem aggregation is dropped). Reports:
 *
 *  - `missingSchemas`: components referenced in content with no local schema
 *    (descent into that subtree stops).
 *  - `driftByComponent`: per component, content fields the schema does not
 *    declare (schema drift; those fields are lost on push).
 *
 * Fields named `component` or starting with `_` are ignored. We surface these
 * as warnings (non-fatal) rather than aborting the push.
 */
import type { ComponentSchemas, Story } from '../types';
import { walkRichtextBloks } from './richtext';

export interface SchemaIssues {
  driftByComponent: Map<string, Set<string>>;
  missingSchemas: Set<string>;
}

const RESERVED_KEYS = new Set(['component']);
const isReservedKey = (key: string) => RESERVED_KEYS.has(key) || key.startsWith('_');

const addDrift = (
  driftByComponent: Map<string, Set<string>>,
  component: string,
  field: string,
): void => {
  const existing = driftByComponent.get(component) ?? new Set<string>();
  existing.add(field);
  driftByComponent.set(component, existing);
};

/**
 * Validates a story's content against component schemas without mutating either
 * input. Descends into `bloks` (array of bloks) and `richtext` (AST, recursing
 * into `type: 'blok'` nodes).
 */
export const validateStoryAgainstSchemas = (
  story: Story,
  schemas: ComponentSchemas,
): SchemaIssues => {
  const driftByComponent = new Map<string, Set<string>>();
  const missingSchemas = new Set<string>();

  const visit = (data: unknown): void => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) { return; }
    const node = data as Record<string, unknown>;
    const componentName = node.component;
    if (typeof componentName !== 'string' || componentName.length === 0) { return; }

    const schema = schemas[componentName] as Record<string, unknown> | undefined;
    if (!schema) {
      missingSchemas.add(componentName);
      return;
    }

    for (const [fieldName, fieldValue] of Object.entries(node)) {
      if (isReservedKey(fieldName)) { continue; }

      const normalized = fieldName.replace(/__i18n__.*/, '');
      const fieldSchema = schema[normalized] as Record<string, unknown> | undefined;

      if (!fieldSchema) {
        addDrift(driftByComponent, componentName, normalized);
        continue;
      }

      const fieldType = typeof fieldSchema.type === 'string' ? fieldSchema.type : undefined;

      if (fieldType === 'bloks' && Array.isArray(fieldValue)) {
        for (const item of fieldValue) { visit(item); }
      }
      else if (fieldType === 'richtext' && fieldValue && typeof fieldValue === 'object') {
        walkRichtextBloks(fieldValue, blok => visit(blok));
      }
    }
  };

  visit(story.content);

  return { driftByComponent, missingSchemas };
};

/** Formats a story's schema issues as one-line warnings (empty when clean). */
export const formatStoryWarnings = (story: Story, issues: SchemaIssues): string[] => {
  const identifier = story.full_slug || story.slug || String(story.id);
  const warnings: string[] = [];
  for (const component of issues.missingSchemas) {
    warnings.push(`Story "${identifier}" references component "${component}" with no schema in dev — references in it cannot be remapped.`);
  }
  for (const [component, fields] of issues.driftByComponent) {
    warnings.push(`Story "${identifier}" has fields not declared in "${component}" schema: ${[...fields].sort().join(', ')}.`);
  }
  return warnings;
};
