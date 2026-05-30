/**
 * Stateless cross-space story-link bridge.
 *
 * The CLI persisted a uuid manifest so links between stories survived across
 * spaces. We are stateless, so instead we resolve every story-link reference
 * found in content (richtext-link `uuid`s, multilink `id`s, options
 * `internal_stories` ids) to its dev `full_slug`, find the prod story with the
 * same slug, and add the dev→prod mapping. Links we cannot resolve are warned
 * about and left unchanged.
 *
 * Both functions here are pure: `collectStoryLinkReferences` walks content by
 * schema; `bridgeStoryLinks` takes injected resolvers so it is trivially
 * unit-testable.
 */
import type { ComponentSchemas, Story, StoryMap } from '../types';

export interface StoryLinkRef {
  uuid?: string;
  id?: number;
}

const normalizeFullSlug = (slug: string): string => slug.replace(/\/$/, '');

/**
 * Collects every story-link reference in a story's content, dispatched by the
 * component schema field types (mirrors the ref-mapper's traversal).
 */
export const collectStoryLinkReferences = (
  story: Story,
  schemas: ComponentSchemas,
): StoryLinkRef[] => {
  const refs: StoryLinkRef[] = [];

  const pushRef = (ref: StoryLinkRef): void => {
    if (ref.uuid != null || ref.id != null) {
      refs.push(ref);
    }
  };

  const visitContent = (data: any): void => {
    if (!data?.component) { return; }
    const schema = schemas[data.component] as Record<string, any> | undefined;
    if (!schema) { return; }

    for (const [fieldName, fieldValue] of Object.entries<any>(data)) {
      const fieldSchema = schema[fieldName.replace(/__i18n__.*/, '')] as Record<string, any> | undefined;
      const fieldType = fieldSchema && typeof fieldSchema === 'object' ? fieldSchema.type : undefined;

      if (fieldType === 'multilink') {
        if (fieldValue && fieldValue.linktype === 'story') {
          pushRef({ id: typeof fieldValue.id === 'number' ? fieldValue.id : undefined, uuid: typeof fieldValue.uuid === 'string' ? fieldValue.uuid : undefined });
        }
      }
      else if (fieldType === 'options' && fieldSchema?.source === 'internal_stories' && Array.isArray(fieldValue)) {
        for (const entry of fieldValue) {
          if (typeof entry === 'number') { pushRef({ id: entry }); }
          else if (typeof entry === 'string') { pushRef({ uuid: entry }); }
        }
      }
      else if (fieldType === 'bloks' && Array.isArray(fieldValue)) {
        for (const blok of fieldValue) { visitContent(blok); }
      }
      else if (fieldType === 'richtext' && fieldValue && typeof fieldValue === 'object') {
        visitRichtext(fieldValue);
      }
    }
  };

  const visitRichtext = (node: any): void => {
    if (Array.isArray(node)) {
      for (const item of node) { visitRichtext(item); }
      return;
    }
    if (!node || typeof node !== 'object') { return; }
    if (node.type === 'link' && node.attrs?.linktype === 'story' && typeof node.attrs.uuid === 'string') {
      pushRef({ uuid: node.attrs.uuid });
    }
    if (node.type === 'blok' && Array.isArray(node.attrs?.body)) {
      for (const blok of node.attrs.body) { visitContent(blok); }
    }
    for (const value of Object.values(node)) { visitRichtext(value); }
  };

  visitContent(story.content);
  return refs;
};

export interface BridgeStoryLinksOptions {
  references: Iterable<StoryLinkRef>;
  /** The story map, mutated in place with any newly-bridged mappings. */
  storyMap: StoryMap;
  /** Resolves a reference to the dev story's normalized full_slug (or undefined). */
  resolveDevFullSlug: (ref: StoryLinkRef) => string | undefined;
  /** Resolves a normalized full_slug to the prod story ref (or undefined). */
  resolveProdBySlug: (normalizedSlug: string) => { id: number; uuid: string } | undefined;
  /** Called with a human-readable message for each reference that cannot be bridged. */
  onWarn?: (message: string) => void;
}

export interface BridgeResult {
  added: number;
  unresolved: StoryLinkRef[];
}

/**
 * Ensures every story-link reference has a dev→prod mapping in `storyMap`.
 * References already mapped (e.g. by Pass 1 of the story push) are skipped.
 */
export const bridgeStoryLinks = ({
  references,
  storyMap,
  resolveDevFullSlug,
  resolveProdBySlug,
  onWarn,
}: BridgeStoryLinksOptions): BridgeResult => {
  const unresolved: StoryLinkRef[] = [];
  const seen = new Set<string>();
  let added = 0;

  for (const ref of references) {
    const dedupeKey = `${ref.uuid ?? ''}|${ref.id ?? ''}`;
    if (seen.has(dedupeKey)) { continue; }
    seen.add(dedupeKey);

    const uuidMapped = ref.uuid != null && storyMap.has(ref.uuid);
    const idMapped = ref.id != null && storyMap.has(ref.id);
    // Already mapped from Pass 1 (or an earlier reference); nothing to bridge.
    if ((ref.uuid == null || uuidMapped) && (ref.id == null || idMapped)) {
      continue;
    }

    const devFullSlug = resolveDevFullSlug(ref);
    const prodRef = devFullSlug ? resolveProdBySlug(normalizeFullSlug(devFullSlug)) : undefined;

    if (!prodRef) {
      unresolved.push(ref);
      const label = ref.uuid ?? `id ${ref.id}`;
      onWarn?.(
        `Could not bridge story link ${label}${devFullSlug ? ` (dev slug "${devFullSlug}")` : ''} — no matching prod story. Include the linked story in the sync set or the link will point at the dev id.`,
      );
      continue;
    }

    if (ref.uuid != null && !uuidMapped) {
      storyMap.set(ref.uuid, prodRef.uuid);
      added += 1;
    }
    if (ref.id != null && !idMapped) {
      storyMap.set(ref.id, prodRef.id);
      added += 1;
    }
  }

  return { added, unresolved };
};
