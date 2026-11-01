-- Print queue for the restaurant print helper (scripts/print-helper.mjs).
-- Additive only: KOT/BOT tickets are queued here and picked up by the helper,
-- which sends kitchen tickets to the kitchen printer and bar tickets to the
-- bar printer. Nothing financial reads or writes this table.
CREATE TABLE IF NOT EXISTS print_jobs (
  id SERIAL PRIMARY KEY,
  kot_id INTEGER REFERENCES kots(id) ON DELETE SET NULL,
  station TEXT NOT NULL DEFAULT 'main',
  kind TEXT NOT NULL DEFAULT 'ticket',
  label TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_ms BIGINT NOT NULL DEFAULT 0,
  claimed_ms BIGINT,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  printed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, next_try_ms);
