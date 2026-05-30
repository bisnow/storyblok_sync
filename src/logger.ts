/**
 * GitHub-Actions-aware logger — a thin wrapper over `@actions/core` workflow
 * commands (annotations, collapsible groups, job summary).
 *
 * Debug mode is selected by the `debug` input OR GitHub step-debug
 * (`core.isDebug()`). When `isDebug` is on, `debug()` force-emits a visible
 * `core.info('🔍 …')` line; otherwise it routes to `core.debug` (only shown
 * when repo step-debug is enabled). One line per call either way.
 */
import * as core from '@actions/core';

export interface Logger {
  readonly isDebug: boolean;
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
  startSection: (label: string) => void;
  endSection: () => void;
  summaryTable: (headers: string[], rows: string[][]) => void;
}

export function createLogger(isDebug: boolean): Logger {
  return {
    isDebug,
    info: message => core.info(message),
    warning: message => core.warning(message),
    error: message => core.error(message),
    debug: (message) => {
      if (isDebug) {
        core.info(`🔍 ${message}`);
      }
      else {
        core.debug(message);
      }
    },
    startSection: label => core.startGroup(label),
    endSection: () => core.endGroup(),
    summaryTable: (headers, rows) => {
      core.summary.addTable([
        headers.map(h => ({ data: h, header: true })),
        ...rows.map(row => row.map(cell => ({ data: cell }))),
      ]);
    },
  };
}

/** A no-op logger for tests / dry contexts that should not emit workflow commands. */
export const silentLogger: Logger = {
  isDebug: false,
  info: () => {},
  warning: () => {},
  error: () => {},
  debug: () => {},
  startSection: () => {},
  endSection: () => {},
  summaryTable: () => {},
};
