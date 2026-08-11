export const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS windows (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  window_index           INTEGER NOT NULL UNIQUE,
  start_time             INTEGER NOT NULL,
  end_time               INTEGER NOT NULL,
  allocation_microdollars REAL    NOT NULL,
  used_microdollars      REAL    NOT NULL DEFAULT 0,
  rollover_before        REAL    NOT NULL DEFAULT 0,
  rollover_after         REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp                 INTEGER NOT NULL,
  provider                  TEXT    NOT NULL DEFAULT '',
  model                     TEXT    NOT NULL,
  estimated_cost            REAL    NOT NULL,
  actual_cost               REAL    NOT NULL,
  input_tokens              INTEGER NOT NULL DEFAULT 0,
  output_tokens             INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens         INTEGER NOT NULL DEFAULT 0,
  compression_applied       INTEGER NOT NULL DEFAULT 0,
  compression_ratio         REAL    NOT NULL DEFAULT 1.0,
  window_id                 INTEGER NOT NULL,
  balance_before            REAL    NOT NULL,
  balance_after             REAL    NOT NULL,
  catastrophic_cap_triggered INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (window_id) REFERENCES windows(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_window    ON requests(window_id);
CREATE INDEX IF NOT EXISTS idx_requests_provider   ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_windows_index      ON windows(window_index);
`;
