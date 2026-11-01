import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PosDatabase } from '../../lib/db/index.js';
import { ensureRecipeTables } from '../../lib/recipes.js';
import { openBusinessDay } from '../../lib/business-days.js';
import { applyStockChange } from '../../lib/inventory-ledger.js';
import { createPurchase, receiptDeltas, updatePurchase } from '../../lib/purchases.js';

const actor = { id: 1, full_name: 'Admin', role: 'admin' };

// One database for the file: some schema setup is cached per process, so a second fresh DB would miss tables.
// Every test uses its own inventory items.
const file = path.join(os.tmpdir(), `purchase-edit-delta-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(file);
let ready;
let testNumber = 0;
test.after(() => { try { db.db.close(); } catch { /* ignore */ } fs.rmSync(file, { force: true }); });

async function setup() {
  ready ||= (async () => { await ensureRecipeTables(db); await openBusinessDay(db, { opening_cash: 10000000 }, actor); })();
  await ready;
  const tag = ++testNumber;
  const addItem = async (label, { factor = 1, purchaseUnit = 'bottle', unit = 'bottle', cost = 0 } = {}) => (await db.run(
    `INSERT INTO inventory_items (item_name,name,quantity,unit,purchase_unit,consumption_unit,conversion_factor,cost_per_unit,is_archived)
     VALUES (?,?,0,?,?,?,?,?,0)`,
    [`${label} ${tag}`, `${label} ${tag}`, unit, purchaseUnit, unit, factor, cost]
  )).lastInsertRowid;
  const qty = async (id) => Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [id])).quantity);
  const cost = async (id) => Number((await db.get('SELECT cost_per_unit FROM inventory_items WHERE id=?', [id])).cost_per_unit);
  const receipts = async (purchaseId, itemId) => db.all(
    `SELECT quantity_changed FROM stock_movements WHERE change_type='purchase_receipt' AND reference_id=? AND inventory_item_id=? ORDER BY id`,
    [String(purchaseId), itemId]
  );
  const sell = (itemId, n) => applyStockChange(db, { inventory_item_id: itemId, quantity: -n, change_type: 'order_deduction', reference_id: 999 });
  const buy = (items, extra = {}) => createPurchase(db, { supplier: 'Bev Supplier', payment_method: 'cash', received_by: actor.id, performed_by: actor.id, items, ...extra });
  const edit = (id, items, extra = {}) => updatePurchase(db, id, { supplier: 'Bev Supplier', payment_method: 'cash', received_by: actor.id, performed_by: actor.id, items, ...extra });
  return { db, addItem, qty, cost, receipts, sell, buy, edit };
}

test('reported case: adding a forgotten item to an edited purchase leaves sold beer at 17', async () => {
  const { db, addItem, qty, receipts, sell, buy, edit } = await setup();
  const beer = await addItem('Beer');
  const rice = await addItem('Rice', { unit: 'kg', purchaseUnit: 'kg' });
  const p = await buy([{ inventory_item_id: beer, quantity: 20, unit_cost: 300 }]);
  await sell(beer, 3);
  assert.equal(await qty(beer), 17);

  await edit(p.id, [
    { inventory_item_id: beer, quantity: 20, unit_cost: 300 },
    { inventory_item_id: rice, quantity: 5, unit_cost: 100 },
  ]);
  assert.equal(await qty(beer), 17, 'beer must not be re-inflated by the edit');
  assert.equal(await qty(rice), 5);
  assert.deepEqual((await receipts(p.id, beer)).map((m) => Number(m.quantity_changed)), [20], 'unchanged beer writes no movement');

  // Repeated save of the same lines is a no-op.
  await edit(p.id, [
    { inventory_item_id: rice, quantity: 5, unit_cost: 100 },
    { inventory_item_id: beer, quantity: 20, unit_cost: 300 },
  ]);
  assert.equal(await qty(beer), 17);
  assert.equal(await qty(rice), 5);
  assert.equal((await receipts(p.id, rice)).length, 1);
  const expense = await db.get(`SELECT amount FROM expenses WHERE source_type='purchase' AND source_id=?`, [p.id]);
  assert.equal(Number(expense.amount), 6500, 'expense follows the edited total');
});

test('quantity changes post only the difference; increases keep moving-average valuation', async () => {
  const { addItem, qty, cost, receipts, sell, buy, edit } = await setup();
  const beer = await addItem('Beer');
  const p = await buy([{ inventory_item_id: beer, quantity: 20, unit_cost: 300 }]);
  await sell(beer, 3);
  await edit(p.id, [{ inventory_item_id: beer, quantity: 25, unit_cost: 340 }]);
  assert.equal(await qty(beer), 22);
  // 17 @ 300 + 5 @ 340 → 22 @ 309.09…
  assert.ok(Math.abs((await cost(beer)) - (17 * 300 + 5 * 340) / 22) < 1e-6);
  await edit(p.id, [{ inventory_item_id: beer, quantity: 21, unit_cost: 340 }]);
  assert.equal(await qty(beer), 18);
  assert.deepEqual((await receipts(p.id, beer)).map((m) => Number(m.quantity_changed)), [20, 5, -4]);
});

test('duplicate lines aggregate by item regardless of order', async () => {
  const { addItem, qty, receipts, buy, edit } = await setup();
  const beer = await addItem('Beer');
  const wine = await addItem('Wine');
  const p = await buy([
    { inventory_item_id: beer, quantity: 8, unit_cost: 300 },
    { inventory_item_id: wine, quantity: 2, unit_cost: 900 },
    { inventory_item_id: beer, quantity: 12, unit_cost: 300 },
  ]);
  await edit(p.id, [
    { inventory_item_id: wine, quantity: 2, unit_cost: 900 },
    { inventory_item_id: beer, quantity: 20, unit_cost: 300 },
  ]);
  assert.equal(await qty(beer), 20);
  assert.equal(await qty(wine), 2);
  assert.equal((await receipts(p.id, beer)).length, 2, 'only the two original receipt movements');
  assert.deepEqual(receiptDeltas(
    [{ inventory_item_id: 2, quantity_received: 3 }, { inventory_item_id: 1, quantity_received: 5 }], 'received',
    [{ inventory_item_id: 1, quantity_received: 5 }, { inventory_item_id: 2, quantity_received: 1 }, { inventory_item_id: 2, quantity_received: 2 }], 'received',
  ), []);
});

test('removed and replaced items reverse only their own quantity', async () => {
  const { addItem, qty, sell, buy, edit } = await setup();
  const beer = await addItem('Beer');
  const wine = await addItem('Wine');
  const cider = await addItem('Cider');
  const p = await buy([
    { inventory_item_id: beer, quantity: 20, unit_cost: 300 },
    { inventory_item_id: wine, quantity: 6, unit_cost: 900 },
  ]);
  await sell(beer, 3);
  await edit(p.id, [
    { inventory_item_id: beer, quantity: 20, unit_cost: 300 },
    { inventory_item_id: cider, quantity: 6, unit_cost: 400 }, // wine was entered by mistake
  ]);
  assert.equal(await qty(beer), 17);
  assert.equal(await qty(wine), 0);
  assert.equal(await qty(cider), 6);
});

test('a reduction larger than the stock left is refused and the whole edit rolls back', async () => {
  const { db, addItem, qty, receipts, sell, buy, edit } = await setup();
  const beer = await addItem('Beer');
  const rice = await addItem('Rice', { unit: 'kg', purchaseUnit: 'kg' });
  const p = await buy([{ inventory_item_id: beer, quantity: 20, unit_cost: 300 }], { invoice_number: 'INV-1' });
  await sell(beer, 3);
  const linesBefore = await db.all('SELECT inventory_item_id, quantity_received FROM purchase_items WHERE purchase_id=? ORDER BY id', [p.id]);

  await assert.rejects(
    edit(p.id, [
      { inventory_item_id: rice, quantity: 5, unit_cost: 100 },
      { inventory_item_id: beer, quantity: 2, unit_cost: 300 }, // would remove 18, only 17 left
    ], { invoice_number: 'INV-1-EDIT' }),
    (error) => error.status === 409 && error.code === 'purchase_edit_stock_short' && /only 17/.test(error.message),
  );
  assert.equal(await qty(beer), 17, 'stock untouched');
  assert.equal(await qty(rice), 0, 'the added line was rolled back too');
  assert.deepEqual(await db.all('SELECT inventory_item_id, quantity_received FROM purchase_items WHERE purchase_id=? ORDER BY id', [p.id]), linesBefore);
  assert.equal((await db.get('SELECT invoice_number FROM purchases WHERE id=?', [p.id])).invoice_number, 'INV-1');
  assert.equal((await receipts(p.id, beer)).length, 1);
  assert.equal(Number((await db.get(`SELECT amount FROM expenses WHERE source_type='purchase' AND source_id=?`, [p.id])).amount), 6000);
});

test('purchase units convert to consumption units exactly once', async () => {
  const { addItem, qty, cost, sell, buy, edit } = await setup();
  const beer = await addItem('Beer crate', { factor: 24, purchaseUnit: 'crate', unit: 'bottle' });
  const p = await buy([{ inventory_item_id: beer, quantity: 2, unit_cost: 4800 }]);
  assert.equal(await qty(beer), 48);
  assert.equal(await cost(beer), 200);
  await sell(beer, 10);
  await edit(p.id, [{ inventory_item_id: beer, quantity: 3, unit_cost: 4800 }]);
  assert.equal(await qty(beer), 62);
  await edit(p.id, [{ inventory_item_id: beer, quantity: 2, unit_cost: 4800 }]);
  assert.equal(await qty(beer), 38);
  await assert.rejects(edit(p.id, [{ inventory_item_id: beer, quantity: 0.25, unit_cost: 4800 }]), /removes 42 bottle but only 38 bottle/);
  assert.equal(await qty(beer), 38);
});

test('draft, partial receipt and back-to-draft transitions post exactly once', async () => {
  const { addItem, qty, receipts, sell, buy, edit } = await setup();
  const beer = await addItem('Beer');
  const p = await buy([{ inventory_item_id: beer, quantity: 20, unit_cost: 300 }], { status: 'draft' });
  assert.equal(await qty(beer), 0, 'a draft posts nothing');

  await edit(p.id, [{ inventory_item_id: beer, quantity_ordered: 20, quantity_received: 12, unit_cost: 300 }], { status: 'partial' });
  assert.equal(await qty(beer), 12);
  await edit(p.id, [{ inventory_item_id: beer, quantity_ordered: 20, quantity_received: 20, unit_cost: 300 }], { status: 'received' });
  assert.equal(await qty(beer), 20);
  await edit(p.id, [{ inventory_item_id: beer, quantity_ordered: 20, quantity_received: 20, unit_cost: 300 }], { status: 'received' });
  assert.deepEqual((await receipts(p.id, beer)).map((m) => Number(m.quantity_changed)), [12, 8]);

  await sell(beer, 3);
  await assert.rejects(edit(p.id, [{ inventory_item_id: beer, quantity: 20, unit_cost: 300 }], { status: 'draft' }), /only 17/);
  assert.equal(await qty(beer), 17);
});
