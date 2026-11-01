/**
 * KOT/BOT sales attribution (lib/production-sales.js) on a real SQLite
 * database: exact paisa allocation, classification from the persisted line
 * snapshot (never today's menu), the ticket fallback for lines sold before
 * KOT/BOT existed, and the Other bucket for what cannot be attributed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { ensureKotProSchema } from '../../lib/kot-service.js';
import { allocateCents, productionSales, topItemsByProduction } from '../../lib/production-sales.js';

const dbPath = path.join(os.tmpdir(), `production-sales-test-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(dbPath);
test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* already gone */ }
  }
});

test('allocation is whole paisa and always sums to the total', () => {
  assert.deepEqual(allocateCents(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocateCents(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(allocateCents(18000, [70000, 110000, 0]), [7000, 11000, 0]);
  assert.equal(allocateCents(500, [0, 0, 0]), null);
  for (let i = 0; i < 200; i += 1) {
    const total = Math.round((Math.random() - 0.2) * 1e6);
    const weights = [Math.random() * 1e4, Math.random() * 1e4, Math.random() < 0.3 ? 0 : Math.random() * 1e4];
    const parts = allocateCents(total, weights);
    assert.equal(parts.reduce((s, p) => s + p, 0), total);
    assert.ok(parts.every(Number.isInteger));
  }
});

let menu;
async function bill(lines, { grandTotal, discount = 0, tax = 0, service = 0, delivery = 0, ticket = 'snapshot' }) {
  const order = (await db.run(`INSERT INTO orders (order_number, order_type, status) VALUES (?, 'takeaway', 'completed')`, [`PS-${Math.random()}`])).lastInsertRowid;
  let subtotal = 0;
  for (const [key, qty] of lines) {
    const m = menu[key];
    subtotal += m.price * qty;
    const type = ticket === 'snapshot' ? m.type : null;
    const line = (await db.run(
      `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, subtotal, sent_quantity, status, production_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'served', ?)`,
      [order, m.id, m.name, qty, m.price, m.price * qty, ticket === 'never' ? 0 : qty, type]
    )).lastInsertRowid;
    if (ticket === 'legacy') {
      // Sent before KOT/BOT existed: no snapshot, but a (kitchen) ticket carried it.
      const kot = (await db.run(`INSERT INTO kots (kot_number, order_id, station, status) VALUES (?, ?, 'main', 'completed')`, [`LEG-${line}`, order])).lastInsertRowid;
      await db.run(`INSERT INTO kot_items (kot_id, order_item_id, quantity) VALUES (?, ?, ?)`, [kot, line, qty]);
    }
  }
  const id = (await db.run(
    `INSERT INTO bills (bill_number, order_id, subtotal, tax, vat_amount, service_charge, delivery_fee, discount_amount, grand_total, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid')`,
    [`PSB-${order}`, order, subtotal, tax, tax, service, delivery, discount, grandTotal]
  )).lastInsertRowid;
  return id;
}

const ALL = { sql: " WHERE LOWER(COALESCE(b.status,'')) = 'paid' AND b.bill_number LIKE 'PSB-%'", params: [] };
const row = (split, type) => split.rows.find((r) => r.production_type === type);

test('setup', async () => {
  await ensureKotProSchema(db);
  await db.run(`CREATE TABLE IF NOT EXISTS bill_corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER, type TEXT, amount REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, business_day_id INTEGER)`);
  for (const col of ['delivery_fee REAL DEFAULT 0', 'vat_amount REAL DEFAULT 0']) {
    await db.run(`ALTER TABLE bills ADD COLUMN ${col}`).catch(() => {});
  }
  const category = await db.get('SELECT id FROM menu_categories ORDER BY id LIMIT 1');
  menu = {};
  for (const [key, name, price, type] of [['momo', 'Momo', 250, 'kot'], ['beer', 'Beer', 400, 'bot']]) {
    const id = (await db.run(`INSERT INTO menu_items (name, category_id, base_price, production_type) VALUES (?, ?, ?, ?)`, [name, category.id, price, type])).lastInsertRowid;
    menu[key] = { id, name, price, type };
  }
});

test('a mixed bill splits every amount by its own lines and reconciles exactly', async () => {
  // 2 momo (500) + 1 beer (400) = 900; discount 90; service 81; VAT 115.83.
  const id = await bill([['momo', 2], ['beer', 1]], { grandTotal: 1006.83, discount: 90, tax: 115.83, service: 81 });
  const split = await productionSales(db, { bills: { sql: ' WHERE b.id = ?', params: [id] } });
  assert.equal(row(split, 'kot').discount, 50);
  assert.equal(row(split, 'bot').discount, 40);
  assert.equal(Math.round((row(split, 'kot').sales + row(split, 'bot').sales) * 100), 100683);
  assert.equal(split.total.sales, 1006.83);
  assert.equal(split.total.tax, 115.83);
  assert.equal(row(split, 'other').sales, 0);
});

test('delivery fees and never-sent lines go to Other instead of being guessed', async () => {
  const delivered = await bill([['beer', 1]], { grandTotal: 450, delivery: 50 });
  const neverSent = await bill([['momo', 1]], { grandTotal: 250, ticket: 'never' });
  const split = await productionSales(db, { bills: { sql: ' WHERE b.id IN (?, ?)', params: [delivered, neverSent] } });
  assert.equal(row(split, 'bot').sales, 400);
  assert.equal(row(split, 'other').delivery_fee, 50);
  assert.equal(row(split, 'other').sales, 300, 'delivery 50 + unclassified momo 250');
  assert.equal(split.total.sales, 700);
});

test('lines sent before KOT/BOT existed count as kitchen through their ticket', async () => {
  const legacy = await bill([['beer', 1]], { grandTotal: 400, ticket: 'legacy' });
  const split = await productionSales(db, { bills: { sql: ' WHERE b.id = ?', params: [legacy] } });
  assert.equal(row(split, 'kot').sales, 400, 'carried by a kitchen ticket, so kitchen — not today’s BOT setting');
  assert.equal(row(split, 'bot').sales, 0);
});

test('reclassifying the menu never moves past sales', async () => {
  const before = await productionSales(db, { bills: ALL });
  await db.run(`UPDATE menu_items SET production_type = 'kot' WHERE id = ?`, [menu.beer.id]);
  const after = await productionSales(db, { bills: ALL });
  await db.run(`UPDATE menu_items SET production_type = 'bot' WHERE id = ?`, [menu.beer.id]);
  assert.deepEqual(after.rows, before.rows);
});

test('a refund follows the bill it refunds, and buckets add up to the total', async () => {
  const barBill = await bill([['beer', 2]], { grandTotal: 800 });
  await db.run(`INSERT INTO bill_corrections (bill_id, type, amount) VALUES (?, 'refund', 300)`, [barBill]);
  const split = await productionSales(db, {
    bills: ALL,
    refunds: { sql: '1 = 1', params: [] },
    bucket: 'b.id',
    refundBucket: 'bc.bill_id',
  });
  assert.equal(row(split, 'bot').refunds, 300);
  assert.equal(row(split, 'kot').refunds, 0);
  const bucketTotal = [...split.buckets.values()].reduce((s, g) => s + Math.round(g.total.net_sales * 100), 0);
  assert.equal(bucketTotal, Math.round(split.total.net_sales * 100));
  const top = await topItemsByProduction(db, { bills: ALL });
  assert.equal(top.bot[0].name, 'Beer');
  // The legacy beer above was carried by a kitchen ticket, so it is a kitchen sale.
  assert.deepEqual(top.kot.map((r) => r.name).sort(), ['Beer', 'Momo']);
  assert.equal(top.bot.reduce((s, r) => s + r.quantity, 0), 4, 'bar: 1 mixed-bill + 1 delivered + 2 refunded-bill beers');
});
