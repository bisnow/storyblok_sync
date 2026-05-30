import type { Story } from '../types';

/** True when a story is published and has no pending unpublished changes. */
export const isStoryPublishedWithoutChanges = (story: Pick<Story, 'published' | 'unpublished_changes'>): boolean =>
  Boolean(story.published && !story.unpublished_changes);
