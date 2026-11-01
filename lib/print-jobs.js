/**
 * Print queue for kitchen and bar tickets (Admin → Printer → "Print helper").
 *
 * When print_mode is 'helper', issuing / reprinting / cancelling a ticket
 * queues a job here instead of opening the browser print dialog. The print
 * helper (scripts/print-helper.mjs, running on a PC in the restaurant) claims
 * jobs and sends kitchen tickets to the kitchen printer and bar tickets to the
 * bar printer at the same time. The ticket text is frozen when queued.
 *
 * Production only: this never touches orders, bills, stock or journals.
 */

import crypto from 'node:crypto';
import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';
import { getKot } from '@/lib/kot-service.js';
import { ticketPrintLines, testPrintLines } from '@/lib/ticket-lines.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5000;
const CLAIM_TIMEOUT_MS = 60000;
const SEEN_WRITE_EVERY_MS = 15000;
let lastSeenWrite = 0;

export async function ensurePrintJobsSchema(db) {
  await ensureSqliteTable(db, `
    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kot_id INTEGER,
      station TEXT NOT NULL DEFAULT 'main',
      kind TEXT NOT NULL DEFAULT 'ticket',
      label TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_ms INTEGER NOT NULL DEFAULT 0,
      claimed_ms INTEGER,
      last_error TEXT,
      dedupe_key TEXT UNIQUE,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      printed_at DATETIME
    )`);
}

export async function loadSettings(db) {
  const rows = await db.all('SELECT setting_key, setting_value FROM system_settings').catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
}

async function saveSetting(db, key, value) {
  await db.run(
    `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

export function helperModeOn(settings) {
  return String(settings.print_mode || 'browser') === 'helper';
}

export function stationPrinter(settings, station) {
  const prefix = station === 'bar' ? 'bar' : 'kitchen';
  const target = String(settings[`${prefix}_printer_target`] || '').trim();
  const connection = settings[`${prefix}_printer_connection`] === 'windows' ? 'windows' : 'network';
  return target ? { connection, target } : null;
}

async function insertJob(db, { kotId = null, station, kind, label, payload, dedupeKey = null, actor = {} }) {
  const conflict = dedupeKey ? ' ON CONFLICT (dedupe_key) DO NOTHING' : '';
  const ins = await db.run(
    `INSERT INTO print_jobs (kot_id, station, kind, label, payload, dedupe_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)${conflict}`,
    [kotId, station, kind, label, JSON.stringify(payload), dedupeKey, actor.id || null]
  );
  if (dedupeKey) {
    const row = await db.get('SELECT id FROM print_jobs WHERE dedupe_key = ?', [dedupeKey]);
    return row?.id ?? null;
  }
  return ins.lastInsertRowid;
}

/**
 * Queue kitchen/bar tickets for the print helper. Returns `{ mode: 'browser' }`
 * when the helper is off (the caller prints in the browser as before), else
 * `{ mode: 'helper', queued: [{ id, label, station }], held: [label] }` —
 * `held` are tickets whose station has no printer set, so they are never sent
 * to the wrong printer. Issue and cancellation tickets are queued once even if
 * the request is retried; reprints always queue a new copy.
 *
 * Never throws: the tickets are already saved, so a queue problem is reported
 * as `failed` (those tickets can be reprinted) instead of failing the request.
 */
export async function queueTicketPrints(db, { kots = [], reprint = false, actor = {} } = {}) {
  let settings;
  try {
    settings = await loadSettings(db);
    if (!helperModeOn(settings)) return { mode: 'browser' };
    await ensurePrintJobsSchema(db);
  } catch (error) {
    console.error('print queue unavailable:', error?.message);
    return { mode: 'browser' };
  }
  const queued = [];
  const held = [];
  const failed = [];
  for (const ticket of kots.filter(Boolean)) {
    const kotId = ticket.kot_id || ticket.id;
    const station = ticket.station === 'bar' ? 'bar' : 'main';
    const label = ticket.kot_number;
    if (!stationPrinter(settings, station)) { held.push(label); continue; }
    try {
      const full = ticket.items ? ticket : await getKot(db, kotId);
      const payload = ticketPrintLines(full, settings, { reprint });
      const id = await insertJob(db, {
        kotId, station, kind: reprint ? 'reprint' : 'ticket', label, payload, actor,
        dedupeKey: reprint ? null : `ticket:${kotId}`,
      });
      queued.push({ id, label, station });
    } catch (error) {
      console.error(`print queue failed for ${label}:`, error?.message);
      failed.push(label);
    }
  }
  return { mode: 'helper', queued, held, failed };
}

export async function queueTestPrint(db, { station, actor = {} }) {
  await ensurePrintJobsSchema(db);
  const settings = await loadSettings(db);
  const where = station === 'bar' ? 'bar' : 'main';
  if (!stationPrinter(settings, where)) {
    const error = new Error(`Set the ${where === 'bar' ? 'bar' : 'kitchen'} printer first.`);
    error.status = 400;
    throw error;
  }
  const id = await insertJob(db, {
    station: where, kind: 'test', label: where === 'bar' ? 'Bar test' : 'Kitchen test',
    payload: testPrintLines(where, settings), actor,
  });
  return { id };
}

/** Recent jobs (or the given ids) with their status, for the POS and Admin → Printer. */
export async function listPrintJobs(db, { ids = null, limit = 20 } = {}) {
  await ensurePrintJobsSchema(db);
  if (ids?.length) {
    const marks = ids.map(() => '?').join(', ');
    return db.all(
      `SELECT id, kot_id, station, kind, label, status, attempts, last_error, created_at, printed_at
       FROM print_jobs WHERE id IN (${marks}) ORDER BY id`, ids);
  }
  return db.all(
    `SELECT id, kot_id, station, kind, label, status, attempts, last_error, created_at, printed_at
     FROM print_jobs ORDER BY id DESC LIMIT ?`, [limit]);
}

export async function retryPrintJob(db, id) {
  await ensurePrintJobsSchema(db);
  await db.run(
    `UPDATE print_jobs SET status = 'pending', attempts = 0, next_try_ms = 0, last_error = NULL WHERE id = ? AND status <> 'done'`,
    [id]
  );
}

// ---------------------------------------------------------------------------
// Print helper side

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/** New helper key. Only its hash is stored; the key is shown once. */
export async function createHelperKey(db) {
  const key = crypto.randomBytes(24).toString('base64url');
  await saveSetting(db, 'print_helper_key_hash', hashKey(key));
  return key;
}

export async function verifyHelperKey(db, request) {
  const header = request.headers.get('authorization') || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return false;
  const row = await db.get(`SELECT setting_value FROM system_settings WHERE setting_key = 'print_helper_key_hash'`);
  const stored = String(row?.setting_value || '');
  if (!stored) return false;
  const given = Buffer.from(hashKey(key));
  const expected = Buffer.from(stored);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Claim due jobs for the helper and say which printer each goes to. A job a
 * helper claimed but never reported is offered again after a minute. Jobs for
 * a station with no printer stay pending until one is set.
 */
export async function claimPrintJobs(db, { limit = 20, now = Date.now() } = {}) {
  await ensurePrintJobsSchema(db);
  const settings = await loadSettings(db);
  if (now - lastSeenWrite > SEEN_WRITE_EVERY_MS) {
    lastSeenWrite = now;
    await saveSetting(db, 'print_helper_last_seen', String(now));
  }
  const printers = { main: stationPrinter(settings, 'main'), bar: stationPrinter(settings, 'bar') };
  const stations = Object.keys(printers).filter((s) => printers[s]);
  if (!stations.length) return { printers, jobs: [] };

  const jobs = await db.transaction(async (tx) => {
    const lock = tx.driver === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';
    const marks = stations.map(() => '?').join(', ');
    const due = await tx.all(
      `SELECT id, station, kind, label, payload FROM print_jobs
       WHERE station IN (${marks})
         AND ((status = 'pending' AND next_try_ms <= ?) OR (status = 'printing' AND claimed_ms < ?))
       ORDER BY id LIMIT ?${lock}`,
      [...stations, now, now - CLAIM_TIMEOUT_MS, limit]
    );
    for (const job of due) {
      await tx.run(
        `UPDATE print_jobs SET status = 'printing', claimed_ms = ?, attempts = attempts + 1 WHERE id = ?`,
        [now, job.id]
      );
    }
    return due;
  });
  return {
    printers,
    jobs: jobs.map((j) => ({ ...j, payload: JSON.parse(j.payload), printer: printers[j.station] })),
  };
}

/** The helper reports a job printed or failed; failures retry a few times. */
export async function finishPrintJob(db, { id, ok, error = null, now = Date.now() }) {
  await ensurePrintJobsSchema(db);
  const job = await db.get('SELECT id, attempts, status FROM print_jobs WHERE id = ?', [id]);
  if (!job || job.status === 'done') return { status: job?.status || 'missing' };
  if (ok) {
    await db.run(`UPDATE print_jobs SET status = 'done', printed_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`, [id]);
    return { status: 'done' };
  }
  const giveUp = Number(job.attempts || 0) >= MAX_ATTEMPTS;
  await db.run(
    `UPDATE print_jobs SET status = ?, next_try_ms = ?, last_error = ? WHERE id = ?`,
    [giveUp ? 'failed' : 'pending', now + RETRY_DELAY_MS, String(error || 'Print failed').slice(0, 300), id]
  );
  return { status: giveUp ? 'failed' : 'pending' };
}
