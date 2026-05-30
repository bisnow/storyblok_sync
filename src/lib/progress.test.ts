import { describe, expect, it } from 'vitest';
import { formatEta, ProgressTracker } from './progress';
import { emptyCounts } from '../types';

describe('formatEta', () => {
  it('formats seconds and minutes', () => {
    expect(formatEta(900)).toBe('~1s');
    expect(formatEta(12_000)).toBe('~12s');
    expect(formatEta(0)).toBe('~0s');
    expect(formatEta(90_000)).toBe('~1m 30s');
    expect(formatEta(120_000)).toBe('~2m');
  });
});

describe('ProgressTracker', () => {
  it('fires each 10% bucket exactly once with done/total + ETA', () => {
    const logs: string[] = [];
    let t = 0;
    const tracker = new ProgressTracker({ label: 'Stories', total: 100, log: m => logs.push(m), now: () => t });
    tracker.start('stories');
    for (let i = 1; i <= 100; i++) {
      t = i * 10; // 10ms per item
      tracker.tick();
    }

    const buckets = logs
      .map(line => line.match(/ (\d+)% \(/))
      .filter((m): m is RegExpMatchArray => m != null)
      .map(m => Number(m[1]));
    expect(buckets).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);

    const tenPercent = logs.find(l => l.includes('10% ('));
    expect(tenPercent).toContain('(10/100)');
    expect(tenPercent).toContain('90 left');
    expect(tenPercent).toContain('~1s remaining');
  });

  it('logs only start + end for small totals', () => {
    const logs: string[] = [];
    const tracker = new ProgressTracker({ label: 'Assets', total: 5, log: m => logs.push(m), now: () => 0 });
    tracker.start('assets');
    for (let i = 0; i < 5; i++) { tracker.tick(); }
    expect(logs).toEqual(['Syncing 5 assets…']);
  });

  it('formats start and end summary lines', () => {
    const logs: string[] = [];
    let t = 0;
    const tracker = new ProgressTracker({ label: 'Stories', total: 3, log: m => logs.push(m), now: () => t });
    tracker.start('stories');
    t = 41_000;
    tracker.end({ ...emptyCounts(), created: 12, updated: 3 });
    expect(logs[0]).toBe('Syncing 3 stories…');
    expect(logs[1]).toBe('Stories done: 12 created, 3 updated, 0 failed in 41s');
  });
});
