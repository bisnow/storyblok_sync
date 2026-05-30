import { describe, expect, it } from 'vitest';
import { clearProcessedFiles, mergeSyncRequests, type ParsedSyncFile, parseSyncFile, selectFullySucceededFiles } from './sync-file';

describe('parseSyncFile', () => {
  it('normalises and de-dupes the three keys, allowing omitted/empty arrays', () => {
    expect(parseSyncFile('f.json', { components: ['a', 'a', 'b'], assets: [] })).toEqual({
      components: ['a', 'b'],
      stories: [],
      assets: [],
    });
  });

  it('rejects malformed files (wrong types)', () => {
    expect(() => parseSyncFile('bad.json', { components: 'nope' })).toThrow('Invalid sync file "bad.json"');
    expect(() => parseSyncFile('bad.json', { stories: [1, 2] })).toThrow('Invalid sync file');
  });
});

describe('mergeSyncRequests', () => {
  it('merges and de-dupes across files', () => {
    const merged = mergeSyncRequests([
      { components: ['a'], stories: ['en/x'], assets: ['i.png'] },
      { components: ['a', 'c'], stories: [], assets: ['j.png'] },
    ]);
    expect(merged).toEqual({ components: ['a', 'c'], stories: ['en/x'], assets: ['i.png', 'j.png'] });
  });
});

describe('clear-processed-files', () => {
  const files: ParsedSyncFile[] = [
    { path: '.storyblok_sync/ok.json', components: ['a'], stories: ['en/x'], assets: [] },
    { path: '.storyblok_sync/partial.json', components: ['b'], stories: [], assets: ['bad.png'] },
  ];

  it('selects only files whose every item succeeded', () => {
    const succeeded = selectFullySucceededFiles(files, { components: new Set(), stories: new Set(), assets: new Set(['bad.png']) });
    expect(succeeded.map(f => f.path)).toEqual(['.storyblok_sync/ok.json']);
  });

  it('deletes succeeded files and reports their paths; retains partial-failure files', async () => {
    const removed: string[] = [];
    const cleared = await clearProcessedFiles(
      files,
      { components: new Set(), stories: new Set(), assets: new Set(['bad.png']) },
      async (path) => { removed.push(path); },
    );
    expect(cleared).toEqual(['.storyblok_sync/ok.json']);
    expect(removed).toEqual(['.storyblok_sync/ok.json']);
  });
});
