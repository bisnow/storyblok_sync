/**
 * Parses `@actions/core` inputs into a typed `Config`. Booleans use
 * `core.getBooleanInput`; `debug` is forced on under GitHub step-debug too.
 */
import * as core from '@actions/core';

export interface Config {
  devSpaceId: number;
  prodSpaceId: number;
  region: string;
  devToken: string;
  prodToken: string;
  syncDir: string;
  dryRun: boolean;
  updateStories: boolean;
  prunePresets: boolean;
  failOnPartial: boolean;
  debug: boolean;
  clearProcessedFiles: boolean;
}

const optionalBoolean = (name: string, fallback: boolean): boolean => {
  const raw = core.getInput(name);
  if (raw === '') {
    return fallback;
  }
  return core.getBooleanInput(name);
};

const requiredNumber = (name: string, fallback: number): number => {
  const raw = core.getInput(name);
  if (raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Input "${name}" must be a number, received "${raw}".`);
  }
  return value;
};

export function readConfig(): Config {
  const devToken = core.getInput('dev-token', { required: true });
  const prodToken = core.getInput('prod-token', { required: true });

  return {
    devSpaceId: requiredNumber('dev-space-id', 571000060559187),
    prodSpaceId: requiredNumber('prod-space-id', 571151439874644),
    region: core.getInput('region') || 'us',
    devToken,
    prodToken,
    syncDir: core.getInput('sync-dir') || '.storyblok_sync',
    dryRun: optionalBoolean('dry-run', false),
    updateStories: optionalBoolean('update-stories', true),
    prunePresets: optionalBoolean('prune-presets', true),
    failOnPartial: optionalBoolean('fail-on-partial', true),
    debug: optionalBoolean('debug', false) || core.isDebug(),
    clearProcessedFiles: optionalBoolean('clear-processed-files', false),
  };
}
