/**
 * Shared types for the action. Re-exports the SDK types we use and defines the
 * narrow `SyncClient` (the subset of the MAPI client our orchestrators call,
 * injected so they can be unit-tested against mocks) plus the in-memory maps
 * that carry source→target identifier mappings across phases.
 */
import type { ManagementApiClient } from '@storyblok/management-api-client';

export type {
  ApiResponse,
  Asset,
  AssetCreate,
  AssetField,
  AssetFolder,
  AssetFolderCreate,
  AssetFolderUpdate,
  AssetUpdate,
  Component,
  ComponentCreate,
  ComponentFolder,
  ComponentUpdate,
  InternalTag,
  ManagementApiClient,
  Preset,
  Story,
  StoryContent,
  StoryCreate,
  StoryUpdate,
} from '@storyblok/management-api-client';

import type { Asset, Component } from '@storyblok/management-api-client';

/**
 * The subset of the MAPI client our orchestrators depend on. Declared as a
 * `Pick` so the real client is trivially assignable while tests can inject a
 * mock (`{...} as unknown as SyncClient`).
 */
export type SyncClient = Pick<
  ManagementApiClient,
  | 'stories'
  | 'components'
  | 'componentFolders'
  | 'presets'
  | 'internalTags'
  | 'assets'
  | 'assetFolders'
>;

/** A component schema (`{ [fieldName]: fieldDef }`). */
export type ComponentSchema = Component['schema'];

/** Lookup of component name → schema, needed by story validation + ref-mapping. */
export type ComponentSchemas = Record<string, ComponentSchema>;

/**
 * The writable + identifying subset of an asset that story content references.
 * `new` in the asset map holds these so the ref-mapper can splice the new
 * asset's id/filename/metadata into content.
 */
export type AssetMapped = Pick<
  Asset,
  'id' | 'filename' | 'alt' | 'title' | 'copyright' | 'source' | 'is_private' | 'meta_data'
>;

/**
 * Dev asset id → { old: the dev asset, new: the prod asset subset }.
 * Keyed by **dev** id because story content references dev ids before remap.
 */
export type AssetMap = Map<number, { old: Asset; new: AssetMapped }>;

/** Dev asset folder id → prod asset folder id. */
export type AssetFolderMap = Map<number, number>;

/**
 * Heterogeneous story map: dev numeric `id` → prod numeric `id` **and** dev
 * string `uuid` → prod string `uuid`, in one map so a single `.get()` resolves
 * either kind of reference.
 */
export type StoryMap = Map<number | string, number | string>;

/** The reference maps threaded into the story ref-mapper. */
export interface RefMaps {
  assets?: AssetMap;
  stories?: StoryMap;
}

/** Per-resource success/update/failure counters surfaced in the summary. */
export interface ResourceCounts {
  created: number;
  updated: number;
  failed: number;
  skipped: number;
}

export const emptyCounts = (): ResourceCounts => ({ created: 0, updated: 0, failed: 0, skipped: 0 });
