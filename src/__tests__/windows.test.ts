import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowSizeMs,
  currentWindowIndex,
  windowBoundaries,
  perWindowAllocation,
  availableMicrodollars,
  catastrophicCap,
  formatDuration,
} from '../pacing/windows';
import type { Config, WindowRow } from '../types';

const BASE_CONFIG: Config = {
  provider: 'deepseek',
  api_key: 'sk-test',
  monthly_budget_microdollars: 10_000_000, // $10
  window_size_hours: 5,
  default_model: 'deepseek-v4-pro',
  session_input_tokens: 30_000,
  session_output_tokens: 8_000,
  local_api_key: 'sk-ag-test',
  install_epoch: 0,
};

function makeWindow(overrides: Partial<WindowRow> = {}): WindowRow {
  return {
    id: 1,
    window_index: 0,
    start_time: 0,
    end_time: 18_000_000,
    allocation_microdollars: 69_444,
    used_microdollars: 0,
    rollover_before: 0,
    rollover_after: 0,
    ...overrides,
  };
}

// ── windowSizeMs ─────────────────────────────────────────────────────────────

test('windowSizeMs: 5h = 18,000,000 ms', () => {
  assert.equal(windowSizeMs(BASE_CONFIG), 18_000_000);
});

test('windowSizeMs: 3h config', () => {
  assert.equal(windowSizeMs({ ...BASE_CONFIG, window_size_hours: 3 }), 10_800_000);
});

// ── currentWindowIndex ────────────────────────────────────────────────────────

test('currentWindowIndex: at epoch = 0', () => {
  assert.equal(currentWindowIndex(BASE_CONFIG, 0), 0);
});

test('currentWindowIndex: 4h 59m after epoch = window 0', () => {
  const now = (5 * 3600 - 60) * 1000; // 4h59m in ms
  assert.equal(currentWindowIndex(BASE_CONFIG, now), 0);
});

test('currentWindowIndex: exactly 5h = window 1', () => {
  assert.equal(currentWindowIndex(BASE_CONFIG, 18_000_000), 1);
});

test('currentWindowIndex: 10h = window 2', () => {
  assert.equal(currentWindowIndex(BASE_CONFIG, 36_000_000), 2);
});

test('currentWindowIndex: non-zero epoch', () => {
  const epoch = 1_700_000_000_000;
  const config = { ...BASE_CONFIG, install_epoch: epoch };
  // Exactly 1 window after epoch
  assert.equal(currentWindowIndex(config, epoch + 18_000_000), 1);
});

// ── windowBoundaries ──────────────────────────────────────────────────────────

test('windowBoundaries: window 0 starts at epoch, ends at epoch+5h', () => {
  const [start, end] = windowBoundaries(BASE_CONFIG, 0);
  assert.equal(start, 0);
  assert.equal(end, 18_000_000);
});

test('windowBoundaries: window 1 starts at 5h', () => {
  const [start, end] = windowBoundaries(BASE_CONFIG, 1);
  assert.equal(start, 18_000_000);
  assert.equal(end, 36_000_000);
});

test('windowBoundaries: windows are contiguous', () => {
  const [, end0] = windowBoundaries(BASE_CONFIG, 0);
  const [start1] = windowBoundaries(BASE_CONFIG, 1);
  assert.equal(end0, start1);
});

// ── perWindowAllocation ───────────────────────────────────────────────────────

test('perWindowAllocation: $10 weekly budget exhausted in 3 days ≈ $0.1736', () => {
  const alloc = perWindowAllocation(BASE_CONFIG);
  // weeklyBudget($10) / (3*24/5 windows) = 2,500,000 / 14.4 ≈ 173,611
  assert.ok(Math.abs(alloc - 173_611) < 1, `expected ~173611, got ${alloc}`);
});

test('perWindowAllocation: scales with budget', () => {
  const double = perWindowAllocation({ ...BASE_CONFIG, monthly_budget_microdollars: 20_000_000 });
  const single = perWindowAllocation(BASE_CONFIG);
  assert.ok(Math.abs(double - single * 2) < 1);
});

// ── availableMicrodollars ────────────────────────────────────────────────────

test('availableMicrodollars: nothing used', () => {
  assert.equal(availableMicrodollars(makeWindow()), 69_444);
});

test('availableMicrodollars: with rollover', () => {
  const win = makeWindow({ rollover_before: 30_000 });
  assert.equal(availableMicrodollars(win), 99_444);
});

test('availableMicrodollars: after spending half', () => {
  const win = makeWindow({ used_microdollars: 34_722 });
  assert.ok(Math.abs(availableMicrodollars(win) - 34_722) < 1);
});

test('availableMicrodollars: overspent (negative is valid)', () => {
  const win = makeWindow({ used_microdollars: 80_000 });
  assert.ok(availableMicrodollars(win) < 0);
});

// ── catastrophicCap ───────────────────────────────────────────────────────────

test('catastrophicCap: 3× allocation when well under $1', () => {
  const win = makeWindow({ allocation_microdollars: 69_444 });
  // 3 * 69,444 = 208,332 — well under 1,000,000
  assert.equal(catastrophicCap(win), 208_332);
});

test('catastrophicCap: capped at $1 for large allocations', () => {
  const win = makeWindow({ allocation_microdollars: 5_000_000 }); // $5 window
  assert.equal(catastrophicCap(win), 1_000_000);
});

// ── formatDuration ────────────────────────────────────────────────────────────

test('formatDuration: under an hour', () => {
  assert.equal(formatDuration(47 * 60 * 1000), '47m');
});

test('formatDuration: hours and minutes', () => {
  assert.equal(formatDuration((2 * 3600 + 18 * 60) * 1000), '2h 18m');
});

test('formatDuration: exactly 5 hours', () => {
  assert.equal(formatDuration(18_000_000), '5h 0m');
});
