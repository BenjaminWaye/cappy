import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { CREATE_SCHEMA } from './schema';
import type { Config, WindowRow, RequestRow, Device } from '../types';

const DB_DIR  = path.join(os.homedir(), '.cappy');
const DB_PATH = path.join(DB_DIR, 'ledger.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(CREATE_SCHEMA);
  }
  return _db;
}

// ── Config ───────────────────────────────────────────────────────────────────

export function getConfig(): Config | null {
  const rows = getDb()
    .prepare('SELECT key, value FROM config')
    .all() as { key: string; value: string }[];
  if (rows.length === 0) return null;
  const m: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!m['provider'] || !m['api_key'] || !m['install_epoch']) return null;
  return {
    provider:                    m['provider'] ?? '',
    api_key:                     m['api_key'] ?? '',
    monthly_budget_microdollars: parseFloat(m['monthly_budget_microdollars'] ?? '10000000'),
    window_size_hours:           parseFloat(m['window_size_hours'] ?? '5'),
    default_model:               m['default_model'] ?? '',
    session_input_tokens:        parseInt(m['session_input_tokens'] ?? '30000'),
    session_output_tokens:       parseInt(m['session_output_tokens'] ?? '8000'),
    local_api_key:               m['local_api_key'] ?? '',
    install_epoch:               parseInt(m['install_epoch'] ?? '0'),
  };
}

export function setConfig(key: string, value: string | number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

// ── Windows ──────────────────────────────────────────────────────────────────

export function getWindowByIndex(idx: number): WindowRow | undefined {
  return getDb()
    .prepare('SELECT * FROM windows WHERE window_index = ?')
    .get(idx) as WindowRow | undefined;
}

export function getWindowById(id: number): WindowRow | undefined {
  return getDb()
    .prepare('SELECT * FROM windows WHERE id = ?')
    .get(id) as WindowRow | undefined;
}

export function insertWindow(
  idx: number,
  startTime: number,
  endTime: number,
  allocation: number,
  rolloverBefore: number,
): WindowRow {
  const db = getDb();
  const r = db.prepare(`
    INSERT INTO windows
      (window_index, start_time, end_time, allocation_microdollars, used_microdollars, rollover_before, rollover_after)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(idx, startTime, endTime, allocation, rolloverBefore, rolloverBefore);
  return db.prepare('SELECT * FROM windows WHERE id = ?').get(r.lastInsertRowid) as WindowRow;
}

export function addWindowUsage(windowId: number, cost: number): void {
  getDb()
    .prepare('UPDATE windows SET used_microdollars = used_microdollars + ? WHERE id = ?')
    .run(cost, windowId);
}

export function setWindowRolloverAfter(windowId: number, rolloverAfter: number): void {
  getDb()
    .prepare('UPDATE windows SET rollover_after = ? WHERE id = ?')
    .run(rolloverAfter, windowId);
}

export function updateWindowAllocation(windowId: number, allocation: number): void {
  getDb()
    .prepare('UPDATE windows SET allocation_microdollars = ? WHERE id = ?')
    .run(allocation, windowId);
}

export function getRecentWindows(limit = 10): WindowRow[] {
  return getDb()
    .prepare('SELECT * FROM windows ORDER BY window_index DESC LIMIT ?')
    .all(limit) as WindowRow[];
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function saveRequest(req: Omit<RequestRow, 'id'>): number {
  const r = getDb().prepare(`
    INSERT INTO requests (
      timestamp, provider, model, estimated_cost, actual_cost,
      input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
      compression_applied, compression_ratio,
      window_id, balance_before, balance_after, catastrophic_cap_triggered
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.timestamp, req.provider, req.model, req.estimated_cost, req.actual_cost,
    req.input_tokens, req.output_tokens, req.cache_hit_tokens, req.cache_miss_tokens,
    req.compression_applied, req.compression_ratio,
    req.window_id, req.balance_before, req.balance_after, req.catastrophic_cap_triggered,
  );
  return r.lastInsertRowid as number;
}

export function getRecentRequests(limit = 50): RequestRow[] {
  return getDb()
    .prepare('SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as RequestRow[];
}

export function getTotalSpent(): number {
  const r = getDb()
    .prepare('SELECT COALESCE(SUM(actual_cost), 0) as total FROM requests')
    .get() as { total: number };
  return r.total;
}

export function getWeeklyUsed(weekStart: number, weekEnd: number): number {
  const r = getDb()
    .prepare(`
      SELECT COALESCE(SUM(actual_cost), 0) as total
      FROM requests
      WHERE timestamp >= ? AND timestamp < ?
    `)
    .get(weekStart, weekEnd) as { total: number };
  return r.total;
}

// ── Devices ──────────────────────────────────────────────────────────────────

export function saveDevice(device: Omit<Device, 'id'>): void {
  getDb().prepare(`
    INSERT INTO devices (name, token_hash, created_at, last_seen_at, revoked_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(device.name, device.token_hash, device.created_at, device.last_seen_at, device.revoked_at);
}

export function getDeviceByTokenHash(hash: string): Device | null {
  return getDb()
    .prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hash) as Device | null;
}

export function touchDevice(hash: string): void {
  getDb()
    .prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?')
    .run(Date.now(), hash);
}

export function getDevices(): Device[] {
  return getDb()
    .prepare('SELECT * FROM devices ORDER BY created_at DESC')
    .all() as Device[];
}

export function revokeDevice(id: number): void {
  getDb()
    .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
    .run(Date.now(), id);
}
