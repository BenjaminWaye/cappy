import {
  getConfig,
  getWindowByIndex,
  getWindowById,
  insertWindow,
  addWindowUsage,
  setWindowRolloverAfter,
  updateWindowAllocation,
  getWeeklyUsed,
} from '../db/ledger';
import type { Config, WindowRow } from '../types';

export interface WindowState {
  window:       WindowRow;
  available:    number;   // microdollars spendable right now
  nextRefillAt: number;   // unix ms when current window ends / next opens
}

export interface WeeklyState {
  budget:      number;   // microdollars allocated this week
  used:        number;   // microdollars spent this week
  available:   number;   // microdollars remaining this week
  weekStart:   number;   // unix ms
  weekEnd:     number;   // unix ms
  week_index:  number;
}

// ── Pure helpers (no DB) ─────────────────────────────────────────────────────

export function windowSizeMs(config: Config): number {
  return config.window_size_hours * 3_600_000;
}

export function currentWindowIndex(config: Config, now = Date.now()): number {
  return Math.floor((now - config.install_epoch) / windowSizeMs(config));
}

export function windowBoundaries(config: Config, idx: number): [start: number, end: number] {
  const sizeMs = windowSizeMs(config);
  return [
    config.install_epoch + idx * sizeMs,
    config.install_epoch + (idx + 1) * sizeMs,
  ];
}

export const WEEK_MS = 7 * 24 * 3_600_000;

export function weeklyBudget(config: Config): number {
  return config.monthly_budget_microdollars / 4;
}

export function perWindowAllocation(config: Config): number {
  // Each window gets a share of the weekly budget sized so that 3 days of
  // back-to-back windows exhausts the week, leaving a 4-day recovery buffer.
  const windowsIn3Days = (3 * 24) / config.window_size_hours;
  return weeklyBudget(config) / windowsIn3Days;
}

export function weekBoundaries(config: Config, weekIdx: number): [start: number, end: number] {
  return [
    config.install_epoch + weekIdx * WEEK_MS,
    config.install_epoch + (weekIdx + 1) * WEEK_MS,
  ];
}

export function currentWeekIndex(config: Config, now = Date.now()): number {
  return Math.floor((now - config.install_epoch) / WEEK_MS);
}

export function getCurrentWeek(config?: Config | null): WeeklyState | null {
  const cfg = config ?? getConfig();
  if (!cfg?.api_key) return null;

  const now      = Date.now();
  const weekIdx  = currentWeekIndex(cfg, now);
  const [start, end] = weekBoundaries(cfg, weekIdx);
  const budget   = weeklyBudget(cfg);
  const used     = getWeeklyUsed(start, end);

  return { budget, used, available: budget - used, weekStart: start, weekEnd: end, week_index: weekIdx };
}

export function availableMicrodollars(win: WindowRow): number {
  return win.allocation_microdollars + win.rollover_before - win.used_microdollars;
}

export function catastrophicCap(win: WindowRow): number {
  return Math.min(3 * win.allocation_microdollars, 1_000_000); // max $1
}

// ── DB-backed operations ─────────────────────────────────────────────────────

export function getCurrentWindow(): WindowState | null {
  const config = getConfig();
  if (!config?.api_key) return null;

  const now = Date.now();
  const idx  = currentWindowIndex(config, now);
  const [start, end] = windowBoundaries(config, idx);
  const allocation = perWindowAllocation(config);

  // No rollover between windows — each window starts fresh.
  // Carryover caused over-spending within the 7-day weekly budget window.
  const rollover = 0;

  let win = getWindowByIndex(idx);
  if (!win) {
    win = insertWindow(idx, start, end, allocation, rollover);
  } else if (win.allocation_microdollars !== allocation) {
    updateWindowAllocation(win.id, allocation);
    win = { ...win, allocation_microdollars: allocation };
  }

  return { window: win, available: availableMicrodollars(win), nextRefillAt: end };
}

export function deductUsage(windowId: number, costMicrodollars: number): void {
  addWindowUsage(windowId, costMicrodollars);
}

// Call this after a window's requests are done to lock in the rollover balance.
// In practice this is called lazily when a new window is first created.
export function closeWindow(windowId: number): void {
  const win = getWindowById(windowId);
  if (!win) return;
  const leftover = Math.max(0, availableMicrodollars(win));
  setWindowRolloverAfter(windowId, leftover);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
