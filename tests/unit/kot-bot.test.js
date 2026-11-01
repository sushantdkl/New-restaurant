/**
 * KOT + BOT: one order, two production tickets.
 *
 * A confirmation splits its unsent lines into a kitchen ticket (KOT) and a bar
 * ticket (BOT). These tests pin the routing contract — which lines land on
 * which ticket, retry safety, the per-line snapshot that keeps history stable,
 * and that cancellations notify the right station — against a real database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { getNepaliDateString } from '../../lib/time-utils.js';
import { openBusinessDay } from '../../lib/business-days.js';
import {
  cancelKot, cancelSentItem, ensureKotProSchema, getOrderWorkspace, issueKot, reprintKot,
} from '../../lib/kot-service.js';
import {
  normalizeProductionType, productionTypeForTicket, stationForProductionType,
} from '../../lib/production-type.js';
import { resolvePrinterSettings } from '../../lib/printer-settings.js';

const dbPath = path.join(os.tmpdir(), `kot-bot-test-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(dbPath);
const admin = { id: 1, full_name: 'Admin One', role: 'admin' };

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already gone */ }
  }
});

let businessDayId;
const menu = {};

test('setup: business day and a kitchen + bar menu', async () => {
  await ensureKotProSchema(db);
  const day = await openBusinessDay(db, { business_date: getNepaliDateString(), opening_cash: 0 }, admin);
  businessDayId = day.id;
  const category = await db.get('SELECT id FROM menu_categories ORDER BY id LIMIT 1');
  for (const [key, name, price, type] of [
    ['momo', 'Chicken Momo', 250, 'kot'],
    ['fries', 'French Fries', 200, 'kot'],
    ['whisky', 'Whisky 60ml', 350, 'bot'],
    ['beer', 'Beer', 400, 'bot'],
    ['tea', 'Tea', 60, null], // never classified: must behave as KOT
  ]) {
    const row = await db.run(
      `INSERT INTO menu_items (name, category_id, base_price, is_available, production_type) VALUES (?, ?, ?, 1, ?)`,
      [name, category.id, price, type]
    );
    menu[key] = { id: row.lastInsertRowid, name, price };
  }
  assert.ok(businessDayId);
});

let tableSeq = 0;
async function openOrder(lines) {
  tableSeq += 1;
  const table = await db.run(`INSERT INTO tables (table_number, status) VALUES (?, 'occupied')`, [`KB-${tableSeq}`]);
  const order = await db.run(
    `INSERT INTO orders (order_number, table_id, table_number, order_type, status, business_day_id)
     VALUES (?, ?, ?, 'dine_in', 'pending', ?)`,
    [`O-KB-${tableSeq}`, table.lastInsertRowid, `KB-${tableSeq}`, businessDayId]
  );
  const orderId = order.lastInsertRowid;
  const itemIds = {};
  for (const [key, quantity] of lines) {
    const m = menu[key];
    const item = await db.run(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, subtotal, sent_quantity, status)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [orderId, m.id, m.name, quantity, m.price, m.price * quantity]
    );
    itemIds[key] = item.lastInsertRowid;
  }
  return { orderId, itemIds };
}

const ticketLines = (ticket) => ticket.items.map((it) => `${it.item_name}x${it.quantity}`).sort();

test('helpers: anything not explicitly BOT is KOT; kitchen keeps the legacy station', () => {
  assert.equal(normalizeProductionType('BOT'), 'bot');
  for (const value of [null, undefined, '', 'kot', 'kitchen', 'bar']) assert.equal(normalizeProductionType(value), 'kot');
  assert.equal(stationForProductionType('kot'), 'main');
  assert.equal(stationForProductionType('bot'), 'bar');
  assert.equal(productionTypeForTicket({ station: 'main' }), 'kot');
  assert.equal(productionTypeForTicket({ station: 'hot-kitchen' }), 'kot');
  assert.equal(productionTypeForTicket({ station: 'bar' }), 'bot');
  const p = resolvePrinterSettings({});
  assert.equal(p.kot_title, 'KITCHEN ORDER TICKET');
  assert.equal(p.bot_title, 'BAR ORDER TICKET');
});

test('a mixed order creates one KOT with only kitchen items and one BOT with only bar items', async () => {
  const { orderId } = await openOrder([['momo', 2], ['fries', 1], ['whisky', 2], ['beer', 1]]);
  const result = await issueKot(db, { orderId, actor: admin, idempotencyKey: `mixed-${orderId}` });

  assert.equal(result.kots.length, 2);
  const [kot, bot] = result.kots;
  assert.equal(kot.station, 'main');
  assert.equal(bot.station, 'bar');
  assert.match(kot.kot_number, /^K-\d{3,}$/);
  assert.match(bot.kot_number, /^BOT-\d{3,}$/);
  assert.deepEqual(ticketLines(kot), ['Chicken Momox2', 'French Friesx1']);
  assert.deepEqual(ticketLines(bot), ['Beerx1', 'Whisky 60mlx2']);
  assert.equal(kot.kot_type, 'new');
  assert.equal(bot.kot_type, 'new', 'the first bar ticket is new for the bar, not "additional"');
  assert.equal(Number(kot.order_id), Number(orderId));
  assert.equal(Number(bot.order_id), Number(orderId));
  assert.equal(result.kot.kot_id, kot.kot_id, '`kot` stays the first ticket for single-ticket callers');

  const lines = await db.all('SELECT item_name, quantity, sent_quantity, production_type FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
  assert.ok(lines.every((l) => Number(l.sent_quantity) === Number(l.quantity)), 'every line is marked sent');
  assert.deepEqual(lines.map((l) => l.production_type), ['kot', 'kot', 'bot', 'bot']);
  const order = await db.get('SELECT status FROM orders WHERE id = ?', [orderId]);
  assert.equal(order.status, 'preparing');
});

test('a kitchen-only order creates only a KOT; unclassified items stay in the kitchen', async () => {
  const { orderId } = await openOrder([['momo', 1], ['tea', 2]]);
  const result = await issueKot(db, { orderId, actor: admin, idempotencyKey: `kitchen-${orderId}` });
  assert.equal(result.kots.length, 1);
  assert.equal(result.kot.station, 'main');
  assert.match(result.kot.kot_number, /^K-/);
  assert.deepEqual(ticketLines(result.kot), ['Chicken Momox1', 'Teax2']);
  assert.equal(await db.get(`SELECT COUNT(*) AS n FROM kots WHERE order_id = ? AND station = 'bar'`, [orderId]).then((r) => Number(r.n)), 0);
});

test('a bar-only order creates only a BOT', async () => {
  const { orderId } = await openOrder([['beer', 3]]);
  const result = await issueKot(db, { orderId, actor: admin, idempotencyKey: `bar-${orderId}` });
  assert.equal(result.kots.length, 1);
  assert.equal(result.kot.station, 'bar');
  assert.match(result.kot.kot_number, /^BOT-/);
  assert.equal(await db.get(`SELECT COUNT(*) AS n FROM kots WHERE order_id = ? AND station <> 'bar'`, [orderId]).then((r) => Number(r.n)), 0);
});

test('sending one station only issues that ticket and leaves the other station unsent', async () => {
  const { orderId } = await openOrder([['momo', 1], ['whisky', 2]]);
  const barOnly = await issueKot(db, { orderId, actor: admin, idempotencyKey: `scope-bot-${orderId}`, productionType: 'bot' });
  assert.equal(barOnly.kots.length, 1);
  assert.equal(barOnly.kot.station, 'bar');
  assert.deepEqual(ticketLines(barOnly.kot), ['Whisky 60mlx2']);
  const momo = await db.get(`SELECT sent_quantity FROM order_items WHERE order_id = ? AND item_name = 'Chicken Momo'`, [orderId]);
  assert.equal(Number(momo.sent_quantity), 0, 'kitchen line is still waiting');

  await assert.rejects(
    issueKot(db, { orderId, actor: admin, idempotencyKey: `scope-bot2-${orderId}`, productionType: 'bot' }),
    (error) => error.code === 'no_unsent_items' && /bar/.test(error.message)
  );
  const kitchen = await issueKot(db, { orderId, actor: admin, idempotencyKey: `scope-kot-${orderId}`, productionType: 'kot' });
  assert.equal(kitchen.kots.length, 1);
  assert.equal(kitchen.kot.station, 'main');
  assert.deepEqual(ticketLines(kitchen.kot), ['Chicken Momox1']);
});

test('retrying a confirmation returns the same tickets and creates nothing new', async () => {
  const { orderId } = await openOrder([['momo', 1], ['whisky', 1]]);
  const key = `retry-${orderId}`;
  const first = await issueKot(db, { orderId, actor: admin, idempotencyKey: key });
  const before = await db.get('SELECT COUNT(*) AS n FROM kots');
  const again = await issueKot(db, { orderId, actor: admin, idempotencyKey: key });
  const after = await db.get('SELECT COUNT(*) AS n FROM kots');

  assert.equal(again.idempotent, true);
  assert.equal(Number(after.n), Number(before.n));
  assert.deepEqual(again.kots.map((k) => k.kot_id), first.kots.map((k) => k.kot_id));
  assert.deepEqual(again.kots.map((k) => k.kot_number), first.kots.map((k) => k.kot_number));
});

test('a later confirmation sends only the new lines, to the right station', async () => {
  const { orderId } = await openOrder([['momo', 1]]);
  await issueKot(db, { orderId, actor: admin, idempotencyKey: `round1-${orderId}` });
  const m = menu.beer;
  await db.run(
    `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, subtotal, sent_quantity, status)
     VALUES (?, ?, ?, 2, ?, ?, 0, 'pending')`,
    [orderId, m.id, m.name, m.price, m.price * 2]
  );
  const round2 = await issueKot(db, { orderId, actor: admin, idempotencyKey: `round2-${orderId}` });
  assert.equal(round2.kots.length, 1, 'no empty kitchen ticket for an all-bar round');
  assert.equal(round2.kot.station, 'bar');
  assert.equal(round2.kot.kot_type, 'new', 'first ticket to the bar on this order');
  assert.deepEqual(ticketLines(round2.kot), ['Beerx2']);
  assert.equal(Number(round2.kot.sequence), 2);

  await assert.rejects(
    issueKot(db, { orderId, actor: admin, idempotencyKey: `round3-${orderId}` }),
    (error) => error.code === 'no_unsent_items'
  );
});

test('reclassifying a menu item never moves lines or tickets that were already sent', async () => {
  const { orderId, itemIds } = await openOrder([['whisky', 1]]);
  const issued = await issueKot(db, { orderId, actor: admin, idempotencyKey: `snap-${orderId}` });
  await db.run(`UPDATE menu_items SET production_type = 'kot' WHERE id = ?`, [menu.whisky.id]);
  try {
    const line = await db.get('SELECT production_type FROM order_items WHERE id = ?', [itemIds.whisky]);
    const ticket = await db.get('SELECT station, kot_number FROM kots WHERE id = ?', [issued.kot.kot_id]);
    const workspace = await getOrderWorkspace(db, orderId);
    assert.equal(line.production_type, 'bot');
    assert.equal(ticket.station, 'bar');
    assert.equal(ticket.kot_number, issued.kot.kot_number);
    assert.equal(workspace.items.find((it) => Number(it.order_item_id) === Number(itemIds.whisky)).production_type, 'bot');
  } finally {
    await db.run(`UPDATE menu_items SET production_type = 'bot' WHERE id = ?`, [menu.whisky.id]);
  }
});

test('cancelling a bar item notifies the bar and leaves the kitchen ticket untouched', async () => {
  const { orderId, itemIds } = await openOrder([['momo', 2], ['beer', 2]]);
  const issued = await issueKot(db, { orderId, actor: admin, idempotencyKey: `cancel-${orderId}` });
  const [kot, bot] = issued.kots;

  const result = await cancelSentItem(db, { orderId, orderItemId: itemIds.beer, quantity: 1, reason: 'Guest changed mind', actor: admin });
  const notice = result.cancellation_kot;
  assert.equal(notice.station, 'bar');
  assert.equal(notice.kot_type, 'cancellation');
  assert.match(notice.kot_number, /^BOT-/);
  assert.equal(Number(notice.amends_kot_id), Number(bot.kot_id));
  assert.deepEqual(ticketLines(notice), ['Beerx1']);

  const momo = await db.get('SELECT quantity, status FROM order_items WHERE id = ?', [itemIds.momo]);
  const beer = await db.get('SELECT quantity, status FROM order_items WHERE id = ?', [itemIds.beer]);
  const kitchen = await db.get('SELECT status, voided FROM kots WHERE id = ?', [kot.kot_id]);
  assert.equal(Number(momo.quantity), 2);
  assert.notEqual(momo.status, 'cancelled');
  assert.equal(Number(beer.quantity), 1);
  assert.equal(kitchen.status, 'pending');
  assert.equal(Number(kitchen.voided || 0), 0);
});

test('cancelling a whole BOT keeps the KOT active and re-opens only the bar lines', async () => {
  const { orderId, itemIds } = await openOrder([['fries', 1], ['whisky', 1]]);
  const issued = await issueKot(db, { orderId, actor: admin, idempotencyKey: `cancelbot-${orderId}` });
  const [kot, bot] = issued.kots;
  await cancelKot(db, { kotId: bot.kot_id, reason: 'Bar out of stock', actor: admin });

  const whisky = await db.get('SELECT sent_quantity FROM order_items WHERE id = ?', [itemIds.whisky]);
  const fries = await db.get('SELECT sent_quantity FROM order_items WHERE id = ?', [itemIds.fries]);
  const kitchen = await db.get('SELECT status FROM kots WHERE id = ?', [kot.kot_id]);
  assert.equal(Number(whisky.sent_quantity), 0);
  assert.equal(Number(fries.sent_quantity), 1);
  assert.equal(kitchen.status, 'pending');

  // Re-sending the reopened bar line goes back to the bar as an additional BOT.
  const resend = await issueKot(db, { orderId, actor: admin, idempotencyKey: `resend-${orderId}` });
  assert.equal(resend.kots.length, 1);
  assert.equal(resend.kot.station, 'bar');
  assert.equal(resend.kot.kot_type, 'additional');
});

test('reprinting a BOT only bumps its reprint counter', async () => {
  const { orderId } = await openOrder([['beer', 1]]);
  const issued = await issueKot(db, { orderId, actor: admin, idempotencyKey: `reprint-${orderId}` });
  const before = {
    kots: Number((await db.get('SELECT COUNT(*) AS n FROM kots')).n),
    moves: Number((await db.get('SELECT COUNT(*) AS n FROM stock_movements').catch(() => ({ n: 0 }))).n),
  };
  const { kot } = await reprintKot(db, { kotId: issued.kot.kot_id, actor: admin });
  const after = {
    kots: Number((await db.get('SELECT COUNT(*) AS n FROM kots')).n),
    moves: Number((await db.get('SELECT COUNT(*) AS n FROM stock_movements').catch(() => ({ n: 0 }))).n),
  };
  assert.equal(kot.is_reprint, true);
  assert.equal(kot.kot_number, issued.kot.kot_number);
  assert.equal(Number(kot.reprint_count), 1);
  assert.deepEqual(after, before);
});

// Sequential here: the SQLite test connection cannot nest transactions. The
// concurrent version runs against PostgreSQL in tests/integration/kot-bot.test.js.
test('kitchen and bar numbers come from separate counters and never repeat', async () => {
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    const { orderId } = await openOrder([['momo', 1], ['beer', 1]]);
    results.push(await issueKot(db, { orderId, actor: admin, idempotencyKey: `seq-${orderId}` }));
  }
  const numbers = results.flatMap((r) => r.kots.map((k) => k.kot_number));
  const kitchen = results.map((r) => Number(r.kots[0].kot_number.replace(/\D/g, '')));
  const bar = results.map((r) => Number(r.kots[1].kot_number.replace(/\D/g, '')));
  for (let i = 1; i < results.length; i += 1) {
    assert.equal(kitchen[i], kitchen[i - 1] + 1, 'kitchen counter is unbroken by bar tickets');
    assert.equal(bar[i], bar[i - 1] + 1, 'bar counter runs on its own');
  }
  assert.equal(new Set(numbers).size, numbers.length);
  const all = await db.all('SELECT kot_number FROM kots');
  assert.equal(new Set(all.map((r) => r.kot_number)).size, all.length, 'no duplicate ticket numbers anywhere');
});

async function setCombined(on) {
  await db.run(
    `INSERT INTO system_settings (setting_key, setting_value) VALUES ('combine_kot_bot_tickets', ?)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
    [on ? 'true' : 'false']
  );
}

test('"Combine KOT and BOT" puts every item on one KOT and leaves the order lines untouched', async () => {
  await setCombined(true);
  try {
    const { orderId, itemIds } = await openOrder([['momo', 2], ['whisky', 2], ['beer', 1]]);
    const before = await db.all('SELECT id, quantity, price, subtotal FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
    // A station scope from an old POS tab is ignored: the whole send is one KOT.
    const result = await issueKot(db, { orderId, actor: admin, idempotencyKey: `combined-${orderId}`, productionType: 'bot' });
    assert.equal(result.kots.length, 1);
    assert.equal(result.kot.station, 'main');
    assert.match(result.kot.kot_number, /^K-/);
    assert.deepEqual(ticketLines(result.kot), ['Beerx1', 'Chicken Momox2', 'Whisky 60mlx2']);

    const after = await db.all('SELECT id, quantity, price, subtotal, sent_quantity, production_type FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
    assert.deepEqual(after.map(({ id, quantity, price, subtotal }) => ({ id, quantity, price, subtotal })), before,
      'quantities, prices and line totals — everything the bill is built from — are unchanged');
    assert.ok(after.every((l) => Number(l.sent_quantity) === Number(l.quantity)));
    assert.deepEqual(after.map((l) => l.production_type), ['kot', 'kot', 'kot'], 'reported under the ticket that carried them');

    // A cancelled drink is announced on the kitchen ticket that carried it.
    const notice = await cancelSentItem(db, { orderId, orderItemId: itemIds.whisky, quantity: 1, reason: 'Changed mind', actor: admin });
    assert.equal(notice.cancellation_kot.station, 'main');
  } finally {
    await setCombined(false);
  }

  const { orderId } = await openOrder([['momo', 1], ['beer', 1]]);
  const split = await issueKot(db, { orderId, actor: admin, idempotencyKey: `uncombined-${orderId}` });
  assert.deepEqual(split.kots.map((k) => k.station), ['main', 'bar'], 'turning it off restores separate KOT and BOT');
});
