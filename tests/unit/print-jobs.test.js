/**
 * Print helper queue: kitchen tickets go to the kitchen printer, bar tickets to
 * the bar printer, each exactly once, and nothing is sent to a station without
 * a printer. Runs against a real (SQLite) database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { getNepaliDateString } from '../../lib/time-utils.js';
import { openBusinessDay } from '../../lib/business-days.js';
import { ensureKotProSchema, issueKot, reprintKot } from '../../lib/kot-service.js';
import {
  claimPrintJobs, createHelperKey, finishPrintJob, listPrintJobs, queueTicketPrints, verifyHelperKey,
} from '../../lib/print-jobs.js';
import { ticketPrintLines } from '../../lib/ticket-lines.js';
import { escposTicket } from '../../scripts/print-helper.mjs';

const dbPath = path.join(os.tmpdir(), `print-jobs-test-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(dbPath);
const admin = { id: 1, full_name: 'Admin One', role: 'admin' };

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already gone */ }
  }
});

async function setSetting(key, value) {
  await db.run(
    `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [key, value]
  );
}

let businessDayId;
const menu = {};
let tableSeq = 0;

async function issueMixedOrder() {
  tableSeq += 1;
  const table = await db.run(`INSERT INTO tables (table_number, status) VALUES (?, 'occupied')`, [`PJ-${tableSeq}`]);
  const order = await db.run(
    `INSERT INTO orders (order_number, table_id, table_number, order_type, status, business_day_id)
     VALUES (?, ?, ?, 'dine_in', 'pending', ?)`,
    [`O-PJ-${tableSeq}`, table.lastInsertRowid, `PJ-${tableSeq}`, businessDayId]
  );
  for (const [key, quantity] of [['momo', 2], ['beer', 1]]) {
    const m = menu[key];
    await db.run(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, subtotal, sent_quantity, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [order.lastInsertRowid, m.id, m.name, quantity, m.price, m.price * quantity]
    );
  }
  return issueKot(db, { orderId: order.lastInsertRowid, actor: admin, idempotencyKey: `pj-${tableSeq}` });
}

const allText = (payload) => payload.lines.map((l) => l.text).join('\n');

test('setup: business day, menu and settings table', async () => {
  await ensureKotProSchema(db);
  await db.run(`CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, setting_key TEXT UNIQUE NOT NULL, setting_value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const day = await openBusinessDay(db, { business_date: getNepaliDateString(), opening_cash: 0 }, admin);
  businessDayId = day.id;
  const category = await db.get('SELECT id FROM menu_categories ORDER BY id LIMIT 1');
  for (const [key, name, price, type] of [['momo', 'Chicken Momo', 250, 'kot'], ['beer', 'Beer', 400, 'bot']]) {
    const row = await db.run(
      `INSERT INTO menu_items (name, category_id, base_price, is_available, production_type) VALUES (?, ?, ?, 1, ?)`,
      [name, category.id, price, type]
    );
    menu[key] = { id: row.lastInsertRowid, name, price };
  }
});

test('browser mode queues nothing, so the device prints as before', async () => {
  const { kots } = await issueMixedOrder();
  const print = await queueTicketPrints(db, { kots, actor: admin });
  assert.deepEqual(print, { mode: 'browser' });
  assert.equal((await listPrintJobs(db)).length, 0);
});

test('helper mode: the KOT goes to the kitchen printer and the BOT to the bar printer', async () => {
  await setSetting('print_mode', 'helper');
  await setSetting('kitchen_printer_connection', 'network');
  await setSetting('kitchen_printer_target', '192.168.1.50');
  await setSetting('bar_printer_connection', 'windows');
  await setSetting('bar_printer_target', 'Bar Epson');

  const { kots } = await issueMixedOrder();
  const print = await queueTicketPrints(db, { kots, actor: admin });
  assert.equal(print.mode, 'helper');
  assert.deepEqual(print.queued.map((j) => j.station), ['main', 'bar']);
  assert.deepEqual(print.held, []);

  // A retried confirmation never queues a second copy.
  const again = await queueTicketPrints(db, { kots, actor: admin });
  assert.deepEqual(again.queued.map((j) => j.id), print.queued.map((j) => j.id));

  const { jobs, printers } = await claimPrintJobs(db);
  assert.equal(jobs.length, 2);
  const kitchen = jobs.find((j) => j.station === 'main');
  const bar = jobs.find((j) => j.station === 'bar');
  assert.deepEqual(kitchen.printer, { connection: 'network', target: '192.168.1.50' });
  assert.deepEqual(bar.printer, { connection: 'windows', target: 'Bar Epson' });
  assert.deepEqual(printers.bar, bar.printer);

  assert.match(allText(kitchen.payload), /KITCHEN ORDER TICKET/);
  assert.match(allText(kitchen.payload), /Chicken Momo/);
  assert.doesNotMatch(allText(kitchen.payload), /Beer/, 'bar items never print in the kitchen');
  assert.match(allText(bar.payload), /BAR ORDER TICKET/);
  assert.match(allText(bar.payload), /Beer/);
  assert.doesNotMatch(allText(bar.payload), /Chicken Momo/, 'kitchen items never print at the bar');
  assert.doesNotMatch(allText(kitchen.payload) + allText(bar.payload), /250|400|Rs/, 'tickets carry no prices');

  assert.equal((await claimPrintJobs(db)).jobs.length, 0, 'a claimed job is not handed out twice');
  await finishPrintJob(db, { id: kitchen.id, ok: true });
  await finishPrintJob(db, { id: bar.id, ok: true });
  const done = await listPrintJobs(db, { ids: [kitchen.id, bar.id] });
  assert.deepEqual(done.map((j) => j.status), ['done', 'done']);
});

test('a station with no printer holds its ticket instead of using the other printer', async () => {
  await setSetting('bar_printer_target', '');
  const { kots } = await issueMixedOrder();
  const print = await queueTicketPrints(db, { kots, actor: admin });
  assert.deepEqual(print.queued.map((j) => j.station), ['main']);
  assert.equal(print.held.length, 1);
  assert.match(print.held[0], /^BOT-/);
  const { jobs } = await claimPrintJobs(db);
  assert.ok(jobs.every((j) => j.station === 'main' && j.printer.target === '192.168.1.50'));
  for (const job of jobs) await finishPrintJob(db, { id: job.id, ok: true });
  await setSetting('bar_printer_target', 'Bar Epson');
});

test('a failed print retries, then shows as failed', async () => {
  const { kots } = await issueMixedOrder();
  const print = await queueTicketPrints(db, { kots: [kots[0]], actor: admin });
  const id = print.queued[0].id;
  let now = Date.now();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const { jobs } = await claimPrintJobs(db, { now });
    assert.ok(jobs.some((j) => j.id === id), `attempt ${attempt} is offered`);
    const result = await finishPrintJob(db, { id, ok: false, error: 'Printer 192.168.1.50: ECONNREFUSED', now });
    assert.equal(result.status, attempt < 5 ? 'pending' : 'failed');
    now += 6000;
  }
  const [job] = await listPrintJobs(db, { ids: [id] });
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /ECONNREFUSED/);
  assert.equal((await claimPrintJobs(db, { now })).jobs.some((j) => j.id === id), false);
});

test('each reprint queues a new copy marked REPRINT', async () => {
  const { kots } = await issueMixedOrder();
  const bot = kots.find((k) => k.station === 'bar');
  const first = await reprintKot(db, { kotId: bot.kot_id, actor: admin });
  const a = await queueTicketPrints(db, { kots: [first.kot], reprint: true, actor: admin });
  const second = await reprintKot(db, { kotId: bot.kot_id, actor: admin });
  const b = await queueTicketPrints(db, { kots: [second.kot], reprint: true, actor: admin });
  assert.notEqual(a.queued[0].id, b.queued[0].id);
  const { jobs } = await claimPrintJobs(db);
  const reprints = jobs.filter((j) => j.kind === 'reprint');
  assert.equal(reprints.length, 2);
  assert.ok(reprints.every((j) => j.station === 'bar' && /\*\*\* REPRINT \*\*\*/.test(allText(j.payload))));
});

test('only the current helper key is accepted', async () => {
  const request = (key) => ({ headers: new Headers(key ? { authorization: `Bearer ${key}` } : {}) });
  const key = await createHelperKey(db);
  assert.equal(await verifyHelperKey(db, request(key)), true);
  assert.equal(await verifyHelperKey(db, request('wrong')), false);
  assert.equal(await verifyHelperKey(db, request(null)), false);
  const replaced = await createHelperKey(db);
  assert.equal(await verifyHelperKey(db, request(key)), false, 'an old key stops working');
  assert.equal(await verifyHelperKey(db, request(replaced)), true);
});

test('ticket text fits the paper and becomes ESC/POS with a cut', () => {
  const kot = {
    kot_number: 'BOT-007', station: 'bar', sequence: 1, kot_type: 'new', table_number: 'T-4',
    items: [{ item_name: 'Himalayan Reserve Single Malt Whisky Large Peg With Soda', quantity: 2 }],
  };
  for (const size of ['58', '80']) {
    const payload = ticketPrintLines(kot, {}, { size });
    for (const line of payload.lines) {
      const width = line.size === 'big' ? payload.cols / 2 : payload.cols;
      if (line.align === 'left') assert.ok(line.text.length <= width, `"${line.text}" fits ${size}mm`);
      assert.match(line.text, /^[\x20-\x7E]*$/);
    }
    const bytes = escposTicket(payload);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
    assert.deepEqual([...bytes.subarray(-4)], [0x1d, 0x56, 0x42, 0x00]);
  }
});
