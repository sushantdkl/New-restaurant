/**
 * KOT/BOT reporting against PostgreSQL, with orders made and paid through the
 * real POS routes (discount, 13% VAT, 10% service charge, a refund and a Rs 0
 * complimentary bill).
 *
 * The contract: every screen's kitchen/bar split is drawn from that screen's
 * own bills and refunds, so KOT + BOT + Other equals its own total to the
 * paisa; a refund follows the bill it refunds; reclassifying a menu item never
 * rewrites past sales; and the item-line filter narrows only item reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '../../lib/db/index.js';
import { AuthService } from '../../lib/auth/auth.js';
import { openBusinessDay, businessDaySummary } from '../../lib/business-days.js';
import { ensureReportSchema, buildReport } from '../../lib/reports.js';
import { composeAnalytics } from '../../lib/analytics.js';
import { nepalDateString } from '../../lib/report-dates.js';
import { refundBill } from '../../lib/bill-corrections.js';
import { POST as createOrder } from '../../app/api/admin/pos/orders/route.js';
import { POST as addItems } from '../../app/api/admin/pos/orders/[id]/items/route.js';
import { POST as issueTickets } from '../../app/api/admin/pos/orders/[id]/kot/route.js';
import { POST as payOrder } from '../../app/api/admin/pos/orders/[id]/pay/route.js';
import { PATCH as patchProduct } from '../../app/api/admin/products/[id]/route.js';
import { GET as dashboard } from '../../app/api/admin/dashboard/route.js';

if (!/^\/km_test_\d+_\d+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw Error('Use scripts/run-integration.mjs to isolate this mutating test.');

const db = Database.getInstance();
const admin = { id: 1, role: 'admin', full_name: 'Test Admin' };
const today = nepalDateString();
const realVerify = AuthService.prototype.verifySession;
test.after(async () => {
  AuthService.prototype.verifySession = realVerify;
  await Database.close();
});

const request = (handler, url, method, body, id) => handler(
  new Request(`http://localhost${url}`, { method, headers: { authorization: 'Bearer contract' }, body: body ? JSON.stringify(body) : undefined }),
  { params: Promise.resolve({ id: String(id) }) }
);
async function ok(responsePromise) {
  const response = await responsePromise;
  const body = await response.json();
  assert.ok(response.status < 300, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}
const paisa = (v) => Math.round(Number(v || 0) * 100);
const eqMoney = (actual, expected, message) => assert.equal(paisa(actual), paisa(expected), `${message}: ${actual} vs ${expected}`);
const row = (split, type) => split.rows.find((r) => r.production_type === type);
const sumRows = (split, key) => split.rows.reduce((s, r) => s + paisa(r[key]), 0) / 100;
async function setSetting(key, value) {
  await db.run(
    `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [key, value]
  );
}

const menu = {};
let seq = 0;
async function sellOrder(lines, payment = {}) {
  seq += 1;
  const created = await ok(request(createOrder, '/api/admin/pos/orders', 'POST', { order_type: 'takeaway' }, ''));
  const orderId = created.workspace?.order?.order_id || created.workspace?.order?.id || created.order_id;
  await db.run('UPDATE orders SET waiter_id = ? WHERE id = ?', [admin.id, orderId]);
  await ok(request(addItems, `/api/admin/pos/orders/${orderId}/items`, 'POST', {
    idempotency_key: `kr-add-${seq}`, items: lines.map(([key, quantity]) => ({ menu_item_id: menu[key], quantity })),
  }, orderId));
  await ok(request(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, 'POST', { idempotency_key: `kr-kot-${seq}` }, orderId));
  if (payment.complimentary) {
    // A Rs 0 settled bill, as /api/restaurant/bills/[id]/payment records a
    // complimentary order (the POS pay route refuses a zero invoice).
    const value = Number((await db.get('SELECT SUM(subtotal) AS v FROM order_items WHERE order_id = ?', [orderId])).v);
    await db.run(
      `INSERT INTO bills (bill_number, order_id, subtotal, tax, vat_amount, service_charge, discount_amount, discount_reason, grand_total, status, business_day_id)
       VALUES (?, ?, ?, 0, 0, 0, ?, 'Complimentary', 0, 'paid', ?)`,
      [`KR-COMP-${seq}`, orderId, value, value, payment.businessDayId]
    );
    await db.run(`UPDATE orders SET status = 'completed' WHERE id = ?`, [orderId]);
    return db.get('SELECT * FROM bills WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  }
  await ok(request(payOrder, `/api/admin/pos/orders/${orderId}/pay`, 'POST', {
    idempotency_key: `kr-pay-${seq}`, payment_method: 'cash', service_charge_mode: 'percent', service_charge_value: 10, ...payment,
  }, orderId));
  return db.get('SELECT * FROM bills WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
}

test('KOT/BOT reporting reconciles on every screen and never rewrites history', async () => {
  AuthService.prototype.verifySession = async () => admin;
  await ensureReportSchema(db);
  await setSetting('vat_percentage', '13');
  const day = await openBusinessDay(db, { business_date: today, opening_cash: 0 }, admin);

  // One category holds both kitchen and bar items: category is not station.
  const mixed = (await db.run(`INSERT INTO menu_categories (name, display_order) VALUES ('KR Snacks & Drinks', 90)`)).lastInsertRowid;
  const kitchen = (await db.run(`INSERT INTO menu_categories (name, display_order) VALUES ('KR Kitchen', 91)`)).lastInsertRowid;
  for (const [key, name, price, type, category] of [
    ['momo', 'KR Chicken Momo', 250, 'kot', mixed],
    ['beer', 'KR Beer', 400, 'bot', mixed],
    ['fries', 'KR French Fries', 200, 'kot', kitchen],
    ['whisky', 'KR Whisky 60ml', 350, 'bot', mixed],
  ]) {
    menu[key] = (await db.run(
      `INSERT INTO menu_items (name, category_id, base_price, is_available, production_type) VALUES (?, ?, ?, 1, ?)`,
      [name, category, price, type]
    )).lastInsertRowid;
  }

  // A: the spec's mixed table — food 700, bar 1100, 10% discount, service, VAT.
  const billA = await sellOrder([['momo', 2], ['fries', 1], ['whisky', 2], ['beer', 1]], { discount: 180, discount_reason: 'Regular guest' });
  // B: kitchen only. C: bar only, later partly refunded. D: complimentary (Rs 0).
  const billB = await sellOrder([['fries', 2]]);
  const billC = await sellOrder([['beer', 3]]);
  const billD = await sellOrder([['momo', 1], ['beer', 1]], { complimentary: true, businessDayId: day.id });
  assert.equal(Number(billD.grand_total), 0, 'the complimentary bill is Rs 0');
  await refundBill(db, { bill_id: billC.id, amount: 300, method: 'cash', reason: 'One beer returned', created_by: 1 });

  // ---------------------------------------------------------------- day close
  const summary = await businessDaySummary(db, day.id);
  const prod = summary.sales.production;
  assert.ok(prod?.has_bar);
  eqMoney(prod.total.net_sales, summary.sales.net_sales, 'business day: KOT + BOT + Other = net sales after refunds');
  eqMoney(sumRows(prod, 'net_sales'), summary.sales.net_sales, 'business day rows add up');
  eqMoney(prod.total.gross, summary.sales.gross_sales, 'gross reconciles');
  eqMoney(prod.total.discount, summary.sales.discounts, 'discount allocation reconciles');
  eqMoney(prod.total.tax, summary.sales.tax, 'tax allocation reconciles');
  eqMoney(prod.total.service_charge, summary.sales.service_charge, 'service charge reconciles');
  eqMoney(prod.total.refunds, summary.sales.refunds, 'refunds reconcile');
  eqMoney(row(prod, 'other').net_sales, 0, 'every sold line here was sent to a station');

  // Mixed bill A splits 700 : 1100 (its own discount, VAT and service follow).
  const expectedKot = (Number(billA.grand_total) * 700) / 1800 + Number(billB.grand_total);
  assert.ok(Math.abs(row(prod, 'kot').sales - expectedKot) <= 0.02, `kitchen share ${row(prod, 'kot').sales} vs ${expectedKot}`);
  // A’s Rs 180 discount splits 70 / 110; D’s comp writes off momo 250 / beer 400.
  eqMoney(row(prod, 'kot').discount, 70 + 250, 'kitchen discount');
  eqMoney(row(prod, 'bot').discount, 110 + 400, 'bar discount');
  // The refund was on a bar-only bill, so it reduces bar sales only.
  eqMoney(row(prod, 'bot').refunds, 300, 'refund follows the original bar bill');
  eqMoney(row(prod, 'kot').refunds, 0, 'kitchen untouched by a bar refund');
  // Complimentary: consumed, not revenue.
  assert.equal(row(prod, 'kot').complimentary_qty, 1);
  assert.equal(row(prod, 'bot').complimentary_qty, 1);

  // ----------------------------------------------------------------- reports
  const range = { start: today, end: today, period: 'business_day', businessDayId: day.id };
  const f = { businessDayId: day.id };

  const overview = await buildReport(db, 'overview', range, f);
  const dayRow = overview.tables.find((t) => t.id === 'business-overview').rows[0];
  eqMoney(dayRow.kot_net + dayRow.bot_net + dayRow.other_net, dayRow.net_revenue, 'overview: per-day KOT + BOT + Other = Net Revenue');
  eqMoney(dayRow.net_revenue, summary.sales.net_sales, 'overview agrees with the business day');
  const stationRows = overview.tables.find((t) => t.id === 'production').rows;
  assert.ok(stationRows.every((r) => ['kot', 'bot', 'other'].includes(r.production_type)), 'no Total row (the table footer sums)');
  eqMoney(stationRows.reduce((s, r) => s + r.net_sales, 0), dayRow.net_revenue, 'overview kitchen-vs-bar rows sum to Net Revenue');
  assert.equal(stationRows.reduce((s, r) => s + Number(r.tickets || 0), 0), 6, 'tickets: A KOT+BOT, B KOT, C BOT, D KOT+BOT — counted, not money');

  const sales = await buildReport(db, 'sales', range, f);
  const kpi = (key) => sales.kpis.find((k) => k.key === key).value;
  eqMoney(sales.production.total.sales, kpi('billed_total'), 'sales: split of Billed Total');
  eqMoney(sales.production.total.net_excl_tax, kpi('net'), 'sales: split of Net Sales (excl. tax)');
  eqMoney(sales.production.total.discount, kpi('discounts'), 'sales: discounts');
  const daily = sales.tables.find((t) => t.id === 'daily-sales-summary').rows[0];
  eqMoney(daily.kot_sales + daily.bot_sales + daily.other_sales, daily.revenue, 'daily sales: KOT + BOT + Other = Revenue');

  const menuAll = await buildReport(db, 'menu', range, f);
  const menuKot = await buildReport(db, 'menu', range, { ...f, productionType: 'kot' });
  const menuBot = await buildReport(db, 'menu', range, { ...f, productionType: 'bot' });
  const names = (r) => r.table.rows.map((x) => x.name).sort();
  assert.deepEqual(names(menuKot), ['KR Chicken Momo', 'KR French Fries']);
  assert.deepEqual(names(menuBot), ['KR Beer', 'KR Whisky 60ml']);
  const revenue = (r) => r.table.rows.reduce((s, x) => s + paisa(x.revenue), 0);
  assert.equal(revenue(menuKot) + revenue(menuBot), revenue(menuAll), 'item report: KOT + BOT = ALL');
  assert.ok(menuAll.table.columns.some((c) => c.key === 'production_type'), 'item rows show their station');
  const exported = await buildReport(db, 'menu', range, { ...f, productionType: 'bot', exportAll: true });
  assert.deepEqual(names(exported), names(menuBot), 'export follows the BOT filter');

  const categories = await buildReport(db, 'categories', range, f);
  const mixedRow = categories.tables[0].rows.find((r) => r.category === 'KR Snacks & Drinks');
  assert.ok(mixedRow.kot_revenue > 0 && mixedRow.bot_revenue > 0, 'one category, both stations');
  eqMoney(mixedRow.kot_revenue + mixedRow.bot_revenue + mixedRow.other_revenue, mixedRow.revenue, 'category split adds up');
  const categoriesBot = await buildReport(db, 'categories', range, { ...f, productionType: 'bot' });
  assert.equal(categoriesBot.tables[0].rows.find((r) => r.category === 'KR Kitchen'), undefined, 'BOT filter drops kitchen-only categories');

  const employees = await buildReport(db, 'employees', range, f);
  const me = employees.table.rows.find((r) => r._record_id === admin.id);
  eqMoney(me.served_kot + me.served_bot, me.served_revenue, 'waiter: mixed orders counted once, split by station');

  // Item filter does not reach bill-level tabs (they show the split instead).
  const salesBot = await buildReport(db, 'sales', range, { ...f, productionType: 'bot' });
  eqMoney(salesBot.kpis.find((k) => k.key === 'billed_total').value, kpi('billed_total'), 'bill totals are not filtered by station');

  // --------------------------------------------------- analytics and dashboard
  const analytics = await composeAnalytics(db, range, {}, { businessDayId: day.id });
  eqMoney(analytics.production.total.net_sales, analytics.totals.netSales, 'analytics: KOT + BOT + Other = Billed Revenue after Refunds');
  eqMoney(analytics.production.trend.reduce((s, d) => s + d.kot + d.bot + d.other, 0), analytics.totals.netSales, 'analytics trend adds up');
  assert.equal(analytics.production.top.bot[0].name, 'KR Beer', 'top bar item');
  assert.ok(analytics.production.top.kot.every((r) => ['KR Chicken Momo', 'KR French Fries'].includes(r.name)), 'top kitchen items are kitchen items');

  const dash = await ok(dashboard(new Request('http://localhost/api/admin/dashboard', { headers: { authorization: 'Bearer contract' } })));
  eqMoney(dash.stats.production.total.net_sales, dash.stats.kpis.sales.value, 'dashboard: split of today’s sales');

  // ------------------------------------------------ history is not rewritten
  const before = JSON.stringify((await businessDaySummary(db, day.id)).sales.production);
  const menuBefore = JSON.stringify(menuBot.table.rows);
  await ok(request(patchProduct, `/api/admin/products/${menu.beer}`, 'PATCH', { production_type: 'kot' }, menu.beer));
  assert.equal((await db.get('SELECT production_type FROM menu_items WHERE id = ?', [menu.beer])).production_type, 'kot');
  assert.equal(JSON.stringify((await businessDaySummary(db, day.id)).sales.production), before, 'day split unchanged by reclassification');
  assert.equal(JSON.stringify((await buildReport(db, 'menu', range, { ...f, productionType: 'bot' })).table.rows), menuBefore, 'item report unchanged by reclassification');

  // ----------------------------------------------------------- empty period
  const empty = await buildReport(db, 'menu', { start: '2020-01-01', end: '2020-01-01', period: 'custom' }, { productionType: 'bot' });
  assert.deepEqual(empty.table.rows, [], 'no BOT sales: an empty table, not an error');
});
