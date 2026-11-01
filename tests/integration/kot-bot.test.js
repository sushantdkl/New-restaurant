/**
 * KOT + BOT against PostgreSQL, through the real POS routes.
 *
 * Proves the financial contract of bar tickets: a mixed kitchen/bar order is
 * one order and one bill; issuing, retrying and reprinting tickets never moves
 * stock or posts a journal; payment posts exactly what it posted before BOT
 * existed; and the Menu report's KOT/BOT split reconciles to item sales.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '../../lib/db/index.js';
import { AuthService } from '../../lib/auth/auth.js';
import { openBusinessDay, businessDaySummary } from '../../lib/business-days.js';
import { ensureReportSchema, buildReport } from '../../lib/reports.js';
import { nepalDateString } from '../../lib/report-dates.js';
import { cancelSentItem } from '../../lib/kot-service.js';
import { POST as createOrder } from '../../app/api/admin/pos/orders/route.js';
import { POST as addItems } from '../../app/api/admin/pos/orders/[id]/items/route.js';
import { POST as issueTickets } from '../../app/api/admin/pos/orders/[id]/kot/route.js';
import { POST as reprintTicket } from '../../app/api/admin/pos/kots/[id]/reprint/route.js';
import { POST as payOrder } from '../../app/api/admin/pos/orders/[id]/pay/route.js';
import { PATCH as patchProduct } from '../../app/api/admin/products/[id]/route.js';

if (!/^\/km_test_\d+_\d+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw Error('Use scripts/run-integration.mjs to isolate this mutating test.');

const db = Database.getInstance();
const admin = { id: 1, role: 'admin', full_name: 'Test Admin' };
const today = nepalDateString();
const realVerify = AuthService.prototype.verifySession;
test.after(async () => {
  AuthService.prototype.verifySession = realVerify;
  await Database.close();
});

const post = (handler, url, body, id) => handler(
  new Request(`http://localhost${url}`, { method: 'POST', headers: { authorization: 'Bearer contract' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: String(id) }) }
);
async function ok(responsePromise) {
  const response = await responsePromise;
  const body = await response.json();
  assert.ok(response.status < 300, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}
const count = async (sql, params = []) => Number((await db.get(sql, params)).n);
const sum = async (sql, params = []) => Number((await db.get(sql, params)).n || 0);

test('KOT/BOT: one order, two tickets, one bill, unchanged money and stock', async () => {
  AuthService.prototype.verifySession = async () => admin;
  await ensureReportSchema(db);
  const day = await openBusinessDay(db, { business_date: today, opening_cash: 1000 }, admin);

  // Menu: two kitchen items, two bar items, each linked to tracked stock.
  const category = (await db.run(`INSERT INTO menu_categories (name, display_order) VALUES ('KB Contract', 99)`)).lastInsertRowid;
  const menu = {};
  for (const [key, name, price, type] of [
    ['momo', 'KB Chicken Momo', 250, 'kot'], ['fries', 'KB French Fries', 200, 'kot'],
    ['whisky', 'KB Whisky 60ml', 350, 'bot'], ['beer', 'KB Beer', 400, 'bot'],
  ]) {
    const id = (await db.run(
      `INSERT INTO menu_items (name, category_id, base_price, is_available, production_type) VALUES (?, ?, ?, 1, ?)`,
      [name, category, price, type]
    )).lastInsertRowid;
    await db.run(
      `INSERT INTO inventory_items (item_name, quantity, unit, cost_per_unit, menu_item_id) VALUES (?, 100, 'portion', 10, ?)`,
      [name, id]
    );
    menu[key] = id;
  }
  const stockOf = (key) => sum('SELECT quantity AS n FROM inventory_items WHERE menu_item_id = ?', [menu[key]]);

  // Order with the spec's example lines: 2 momo, 1 fries, 2 whisky, 1 beer = Rs 1,800.
  const created = await ok(post(createOrder, '/api/admin/pos/orders', { order_type: 'takeaway' }, ''));
  const orderId = created.workspace?.order?.order_id || created.workspace?.order?.id || created.order_id;
  assert.ok(orderId);
  await ok(post(addItems, `/api/admin/pos/orders/${orderId}/items`, {
    idempotency_key: 'kb-add-1',
    items: [{ menu_item_id: menu.momo, quantity: 2 }, { menu_item_id: menu.fries, quantity: 1 },
      { menu_item_id: menu.whisky, quantity: 2 }, { menu_item_id: menu.beer, quantity: 1 }],
  }, orderId));
  const stockAfterAdd = { momo: await stockOf('momo'), whisky: await stockOf('whisky') };
  assert.equal(stockAfterAdd.momo, 98, 'stock is consumed when items are added (existing lifecycle)');
  assert.equal(stockAfterAdd.whisky, 98);

  const before = {
    moves: await count('SELECT COUNT(*) AS n FROM stock_movements'),
    journals: await count('SELECT COUNT(*) AS n FROM journal_entries'),
    bills: await count('SELECT COUNT(*) AS n FROM bills'),
  };

  // Confirm, then retry the same confirmation.
  const issued = await ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, { idempotency_key: 'kb-confirm-1' }, orderId));
  const retried = await ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, { idempotency_key: 'kb-confirm-1' }, orderId));
  assert.equal(issued.kots.length, 2);
  assert.equal(retried.idempotent, true);
  assert.deepEqual(retried.kots.map((k) => k.kot_id), issued.kots.map((k) => k.kot_id));
  const [kot, bot] = issued.kots;
  assert.equal(kot.station, 'main');
  assert.equal(bot.station, 'bar');
  assert.deepEqual(kot.items.map((i) => i.item_name).sort(), ['KB Chicken Momo', 'KB French Fries']);
  assert.deepEqual(bot.items.map((i) => i.item_name).sort(), ['KB Beer', 'KB Whisky 60ml']);
  assert.equal(await count('SELECT COUNT(*) AS n FROM kots WHERE order_id = ?', [orderId]), 2);

  // Reprint the BOT twice.
  await ok(post(reprintTicket, `/api/admin/pos/kots/${bot.kot_id}/reprint`, {}, bot.kot_id));
  const reprinted = await ok(post(reprintTicket, `/api/admin/pos/kots/${bot.kot_id}/reprint`, {}, bot.kot_id));
  assert.equal(Number(reprinted.kot.reprint_count), 2);
  assert.equal(reprinted.kot.kot_number, bot.kot_number);

  // Tickets, retries and reprints moved no stock, posted no journal, made no bill.
  assert.deepEqual({
    moves: await count('SELECT COUNT(*) AS n FROM stock_movements'),
    journals: await count('SELECT COUNT(*) AS n FROM journal_entries'),
    bills: await count('SELECT COUNT(*) AS n FROM bills'),
  }, before);
  assert.equal(await stockOf('momo'), stockAfterAdd.momo);
  assert.equal(await stockOf('whisky'), stockAfterAdd.whisky);

  // Reclassifying an item afterwards changes nothing already sent.
  await ok(patchProduct(new Request(`http://localhost/api/admin/products/${menu.whisky}`, {
    method: 'PATCH', headers: { authorization: 'Bearer contract' }, body: JSON.stringify({ production_type: 'kot' }),
  }), { params: Promise.resolve({ id: String(menu.whisky) }) }));
  assert.equal((await db.get(`SELECT production_type FROM order_items WHERE order_id = ? AND menu_item_id = ?`, [orderId, menu.whisky])).production_type, 'bot');
  assert.equal((await db.get('SELECT station FROM kots WHERE id = ?', [bot.kot_id])).station, 'bar');

  // One bill for the whole order through the existing payment engine.
  const paid = await ok(post(payOrder, `/api/admin/pos/orders/${orderId}/pay`, { idempotency_key: 'kb-pay-1', payment_method: 'cash' }, orderId));
  const paidAgain = await ok(post(payOrder, `/api/admin/pos/orders/${orderId}/pay`, { idempotency_key: 'kb-pay-1', payment_method: 'cash' }, orderId));
  assert.ok(paid && paidAgain);
  const bills = await db.all('SELECT * FROM bills WHERE order_id = ?', [orderId]);
  assert.equal(bills.length, 1, 'kitchen and bar items share one bill');
  const bill = bills[0];
  assert.equal(Number(bill.subtotal), 1800);
  const journals = await db.all(`SELECT id FROM journal_entries WHERE source_type = 'bill' AND source_id = ?`, [bill.id]);
  assert.equal(journals.length, 1, 'payment retry posts nothing twice');
  const lines = await db.get('SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE journal_id = ?', [journals[0].id]);
  assert.ok(Math.abs(Number(lines.d) - Number(lines.c)) < 0.01, 'bill journal balances');
  const revenue = await sum(
    `SELECT SUM(l.credit - l.debit) AS n FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_id = ? AND a.code = '4010'`,
    [journals[0].id]
  );
  assert.equal(revenue, Number(bill.subtotal) - Number(bill.discount_amount || 0), 'revenue posts once, unsplit by station');
  assert.equal(await count(`SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = ?`, [bill.id]), 1);
  assert.equal(await stockOf('momo'), stockAfterAdd.momo, 'payment does not consume again');

  const summary = await businessDaySummary(db, day);
  assert.equal(Number(summary.cash.expected_cash), 1000 + Number(bill.grand_total), 'drawer expects the one cash sale');

  // Menu report: KOT + BOT reconcile to item sales; tickets are counted, not summed as money.
  const report = await buildReport(db, 'menu', { start: today, end: today }, { businessDayId: day.id });
  const split = report.tables.find((t) => t.id === 'production');
  const detail = report.tables.find((t) => t.id === 'detail');
  assert.ok(split && detail);
  const byType = Object.fromEntries(split.rows.map((r) => [r.production_type, r]));
  // Item value after discount = Item Sales - Discounts (the shared split's columns).
  const itemValue = (r) => Math.round((r.item_sales - r.discount) * 100) / 100;
  assert.equal(itemValue(byType.kot), 700);
  assert.equal(itemValue(byType.bot), 1100);
  assert.equal(itemValue(byType.kot) + itemValue(byType.bot), detail.rows.reduce((s, r) => s + r.revenue, 0));
  assert.equal(byType.kot.tickets, 1);
  assert.equal(byType.bot.tickets, 1);
});

test('KOT/BOT: concurrent confirmations never share a ticket number', async () => {
  AuthService.prototype.verifySession = async () => admin;
  const beer = (await db.get(`SELECT id FROM menu_items WHERE name = 'KB Beer'`)).id;
  const momo = (await db.get(`SELECT id FROM menu_items WHERE name = 'KB Chicken Momo'`)).id;
  const orderIds = [];
  for (let i = 0; i < 6; i += 1) {
    const created = await ok(post(createOrder, '/api/admin/pos/orders', { order_type: 'takeaway' }, ''));
    const orderId = created.workspace?.order?.order_id || created.workspace?.order?.id || created.order_id;
    await ok(post(addItems, `/api/admin/pos/orders/${orderId}/items`, {
      idempotency_key: `kb-conc-add-${i}`, items: [{ menu_item_id: momo, quantity: 1 }, { menu_item_id: beer, quantity: 1 }],
    }, orderId));
    orderIds.push(orderId);
  }
  const results = await Promise.all(orderIds.map((orderId, i) =>
    ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, { idempotency_key: `kb-conc-${i}` }, orderId))));
  const numbers = results.flatMap((r) => r.kots.map((k) => k.kot_number));
  assert.equal(numbers.length, 12);
  assert.equal(new Set(numbers).size, 12);
  const dupes = await db.all('SELECT kot_number FROM kots GROUP BY kot_number HAVING COUNT(*) > 1');
  assert.deepEqual(dupes, []);

  // Cancelling one bar line notifies the bar and keeps the kitchen ticket.
  const target = orderIds[0];
  const beerLine = await db.get('SELECT id FROM order_items WHERE order_id = ? AND menu_item_id = ?', [target, beer]);
  const result = await cancelSentItem(db, { orderId: target, orderItemId: beerLine.id, reason: 'Guest changed mind', actor: admin });
  assert.equal(result.cancellation_kot.station, 'bar');
  assert.match(result.cancellation_kot.kot_number, /^BOT-TW-/);
  const kitchen = await db.get(`SELECT status FROM kots WHERE order_id = ? AND station = 'main'`, [target]);
  assert.equal(kitchen.status, 'pending');
});
