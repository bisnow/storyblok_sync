/**
 * ProgressTracker — emits a start line, a progress line at each 10% boundary
 * (with done/total, remaining and an ETA), and an end summary. For small totals
 * (< 10 items) the per-bucket ticks would be noisy and indistinct, so only the
 * start and end lines are emitted.
 *
 * The clock is injectable (`now`) so ETA math is deterministic in tests.
 */
import type { ResourceCounts } from '../types';

const BUCKETS = 10; // 10% granularity

export interface ProgressTrackerOptions {
  /** Capitalised resource label used to prefix progress/end lines (e.g. "Stories"). */
  label: string;
  /** Total number of items to process. */
  total: number;
  /** Sink for the formatted lines (typically `logger.info`). */
  log: (message: string) => void;
  /** Clock returning monotonically increasing milliseconds. Defaults to `performance.now`. */
  now?: () => number;
}

/** Formats a millisecond duration as a compact `~Ns` / `~Nm Ns` ETA. */
export function formatEta(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `~${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `~${minutes}m` : `~${minutes}m ${rest}s`;
}

export class ProgressTracker {
  private readonly label: string;
  private readonly total: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private done = 0;
  private lastBucket = 0;
  private startedAt = 0;

  constructor(options: ProgressTrackerOptions) {
    this.label = options.label;
    this.total = options.total;
    this.log = options.log;
    this.now = options.now ?? (() => performance.now());
  }

  /** Logs the opening line, e.g. `Syncing 50 stories…`, and starts the clock. */
  start(noun: string): void {
    this.startedAt = this.now();
    this.log(`Syncing ${this.total} ${noun}…`);
  }

  /**
   * Records one completed item. When the completion crosses into a new 10%
   * bucket (and the total is large enough for buckets to be meaningful), logs a
   * progress line with the percentage, counts and ETA.
   */
  tick(): void {
    this.done += 1;
    if (this.total < BUCKETS || this.done >= this.total) {
      return; // small totals: no ticks; final state is covered by end().
    }
    const bucket = Math.floor((this.done / this.total) * BUCKETS);
    if (bucket <= this.lastBucket) {
      return;
    }
    this.lastBucket = bucket;

    const remaining = this.total - this.done;
    const elapsed = this.now() - this.startedAt;
    const etaMs = this.done > 0 ? (elapsed / this.done) * remaining : 0;
    const pct = bucket * BUCKETS;
    this.log(
      `${this.label}  ${pct}% (${this.done}/${this.total}) — ${remaining} left, ${formatEta(etaMs)} remaining`,
    );
  }

  /** Logs the closing summary, e.g. `Stories done: 12 created, 3 updated, 0 failed in 41s`. */
  end(counts: ResourceCounts): void {
    const elapsedSeconds = Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
    this.log(
      `${this.label} done: ${counts.created} created, ${counts.updated} updated, ${counts.failed} failed in ${elapsedSeconds}s`,
    );
  }
}
