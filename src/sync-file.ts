/**
 * Reading, validating, merging and clearing the developer-authored sync files
 * under `<sync-dir>/*.json`. The pure pieces (parse, merge, decide-which-to-
 * clear) are separated from the thin filesystem wrappers so they unit-test
 * without touching disk.
 */
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SyncError, toError } from './lib/result';

const syncFileSchema = z.object({
  components: z.array(z.string()).optional(),
  stories: z.array(z.string()).optional(),
  assets: z.array(z.string()).optional(),
});

export interface SyncRequest {
  components: string[];
  stories: string[];
  assets: string[];
}

export interface ParsedSyncFile extends SyncRequest {
  /** Path to the source file (relative to the working tree). */
  path: string;
}

const dedupe = (values: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
};

/**
 * Validates and normalises one sync file's parsed JSON into a `SyncRequest`.
 * Throws a `SyncError` (naming the file) on malformed input.
 */
export function parseSyncFile(path: string, json: unknown): SyncRequest {
  const result = syncFileSchema.safeParse(json);
  if (!result.success) {
    throw new SyncError(`Invalid sync file "${path}": ${result.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  }
  return {
    components: dedupe(result.data.components),
    stories: dedupe(result.data.stories),
    assets: dedupe(result.data.assets),
  };
}

/** Merges several sync requests into one, de-duplicating each key. */
export function mergeSyncRequests(requests: SyncRequest[]): SyncRequest {
  return {
    components: dedupe(requests.flatMap(r => r.components)),
    stories: dedupe(requests.flatMap(r => r.stories)),
    assets: dedupe(requests.flatMap(r => r.assets)),
  };
}

/**
 * Reads and validates every `*.json` in `syncDir`, returning the individual
 * parsed files (for per-file clearing) and their merged request. A missing
 * directory yields an empty result.
 */
export async function readSyncDir(syncDir: string): Promise<{ files: ParsedSyncFile[]; merged: SyncRequest }> {
  let entries: string[];
  try {
    entries = await readdir(syncDir);
  }
  catch (maybeError) {
    if ((maybeError as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { files: [], merged: { components: [], stories: [], assets: [] } };
    }
    throw maybeError;
  }

  const jsonFiles = entries.filter(name => name.toLowerCase().endsWith('.json')).sort();
  const files: ParsedSyncFile[] = [];

  for (const name of jsonFiles) {
    const path = join(syncDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf-8'));
    }
    catch (maybeError) {
      throw new SyncError(`Could not read/parse sync file "${path}": ${toError(maybeError).message}`);
    }
    files.push({ path, ...parseSyncFile(path, parsed) });
  }

  return { files, merged: mergeSyncRequests(files) };
}

/** Per-resource sets of item identifiers that failed during the run. */
export interface FailedItems {
  components: Set<string>;
  stories: Set<string>;
  assets: Set<string>;
}

/**
 * Returns the sync files whose every listed item succeeded — i.e. none of the
 * items appear in the corresponding `failed` set. A file with any failed item
 * is retained so the next run retries it.
 */
export function selectFullySucceededFiles(files: ParsedSyncFile[], failed: FailedItems): ParsedSyncFile[] {
  return files.filter(file =>
    file.components.every(name => !failed.components.has(name))
    && file.stories.every(slug => !failed.stories.has(slug))
    && file.assets.every(name => !failed.assets.has(name)),
  );
}

/**
 * Deletes the fully-succeeded files from the working tree and returns their
 * paths. The `remove` function is injected so the decision logic is testable
 * without touching disk; defaults to `fs.unlink`.
 */
export async function clearProcessedFiles(
  files: ParsedSyncFile[],
  failed: FailedItems,
  remove: (path: string) => Promise<void> = path => unlink(path),
): Promise<string[]> {
  const toClear = selectFullySucceededFiles(files, failed);
  const cleared: string[] = [];
  for (const file of toClear) {
    await remove(file.path);
    cleared.push(file.path);
  }
  return cleared;
}
