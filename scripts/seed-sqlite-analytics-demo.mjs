/** Local, labeled demo transactions. Existing data is backed up and retained. */
import fs from 'node:fs';
import path from 'node:path';
import SQLite from 'better-sqlite3';
import { PosDatabase } from '../lib/db/index.js';
import { ensureReportSchema } from '../lib/reports.js';
import { ensureRecipeTables, createRecipe, logWastage } from '../lib/recipes.js';
import { ensureInventoryCategorySchema } from '../lib/inventory-categories.js';
import { ensureStockSchema, deductStockForItems } from '../lib/stock.js';
import { ensureAccountingSchema, postSaleJournal } from '../lib/accounting.js';
import { ensureBusinessDaySchema, currentBusinessDay, businessDaySummary, closeBusinessDay, openBusinessDay } from '../lib/business-days.js';
import { createPurchase } from '../lib/purchases.js';
import { nepalDateString } from '../lib/report-dates.js';
import { buildPurchaseSalesAnalysis } from '../lib/purchase-sales-analysis.js';

if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production') throw new Error('Demo seeding is allowed only in local SQLite development.');
const argument = process.argv.find((value) => value.startsWith('--db='));
const target = path.resolve(argument ? argument.slice(5) : 'pos_restaurant.db');
const workspace = path.resolve('.');
if (!target.startsWith(workspace + path.sep) || !target.endsWith('.db') || !fs.existsSync(target)) throw new Error('Choose an existing SQLite database inside this workspace.');
const rollover = process.argv.includes('--rollover');
const today = nepalDateString();
const mark = 'DEMO-ANALYTICS';
const backup = path.join(workspace, '.build-tmp', `before-analytics-demo-${Date.now()}.db`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
const source = new SQLite(target, { readonly: true, fileMustExist: true });
await source.backup(backup); source.close();
console.log(`SQLite backup: ${backup}`);
const db = new PosDatabase(target);
const number = (value) => Number(value.lastInsertRowid);
const shift = (offset) => nepalDateString(new Date(new Date(`${today}T12:00:00+05:45`).getTime() + offset * 86400000));
const timestamp = (date, hour = 10) => (date === today ? new Date() : new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:45`)).toISOString().slice(0, 19).replace('T', ' ');

try {
  await ensureReportSchema(db); await ensureRecipeTables(db); await ensureStockSchema(db);
  await ensureAccountingSchema(db); await ensureBusinessDaySchema(db); await ensureInventoryCategorySchema(db);
  const actor = await db.get("SELECT id,role,full_name FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (!actor) throw new Error('An existing administrator is required.');
  let active = await currentBusinessDay(db);
  if (active && String(active.business_date).slice(0, 10) !== today) {
    if (!rollover) throw new Error('A stale business day is open. Use --rollover only after authorizing its forced close and carry-forward.');
    const session = await db.get("SELECT id FROM business_day_sessions WHERE business_day_id=? AND status='open'", [active.id]);
    if (session) {
      const summary = await businessDaySummary(db, active);
      await closeBusinessDay(db, {
        counted_cash: Math.max(0, Number(summary.cash.expected_cash || 0)),
        force_close_reason: '[DEMO] User-authorized local demo rollover; unfinished work retained by the existing lifecycle.',
        closing_note: '[DEMO] Simulated count for local preview, using expected cash. No physical cash count was performed.',
      }, actor, { force: true });
    }
    const priorSession = await db.get('SELECT counted_cash FROM business_day_sessions WHERE business_day_id=? ORDER BY session_number DESC LIMIT 1', [active.id]);
    active = await openBusinessDay(db, { action: 'start_next', confirm_next_day: true, opening_cash: Math.max(0, Number(priorSession?.counted_cash || 0)),
      opening_note: '[DEMO] Analytics preview — sample restaurant transactions.' }, actor);
    console.log(`Opened business day #${active.id} (${today}); previous unfinished work retained.`);
  } else if (!active) {
    active = await openBusinessDay(db, { business_date: today, opening_cash: 0, opening_note: '[DEMO] Analytics preview — sample restaurant transactions.' }, actor);
    console.log(`Opened business day #${active.id} (${today}).`);
  }

  const dates = [shift(-2), shift(-1), today];
  const days = [];
  for (const date of dates) {
    let day = await db.get('SELECT * FROM business_days WHERE business_date=?', [date]);
    if (!day) {
      const id = number(await db.run(`INSERT INTO business_days(business_date,status,opened_at,closed_at,opened_by,closed_by,opening_cash,opening_note,closing_note)
        VALUES (?,'closed',?,?,?,?,0,?,?)`, [date, timestamp(date, 7), timestamp(date, 22), actor.id, actor.id,
        '[DEMO] Historical analytics sample day.', '[DEMO] Sample day, not a physical cash reconciliation.']));
      await db.run(`INSERT INTO business_day_sessions(business_day_id,session_number,status,opened_at,closed_at,opened_by,closed_by,opening_cash,opening_note,closing_note)
        VALUES (?,1,'closed',?,?,?,?,0,?,?)`, [id, timestamp(date, 7), timestamp(date, 22), actor.id, actor.id, '[DEMO] Sample session.', '[DEMO] Sample close.']);
      day = await db.get('SELECT * FROM business_days WHERE id=?', [id]);
    }
    days.push(day);
  }

  const categories = {};
  for (const [key, name, group] of [['food', '[DEMO] Kitchen ingredients', 'food'], ['beverage', '[DEMO] Bottled drinks', 'beverage'], ['liquor', '[DEMO] Spirits', 'liquor']]) {
    let inventory = await db.get('SELECT id FROM inventory_categories WHERE normalized_name=?', [name.toLowerCase()]);
    if (!inventory) inventory = { id: number(await db.run('INSERT INTO inventory_categories(name,normalized_name,food_group) VALUES (?,?,?)', [name, name.toLowerCase(), group])) };
    let menu = await db.get('SELECT id FROM menu_categories WHERE name=?', [name]);
    if (!menu) menu = { id: number(await db.run('INSERT INTO menu_categories(name,food_group) VALUES (?,?)', [name, group])) };
    categories[key] = { inventory: inventory.id, menu: menu.id };
  }
  const stock = {};
  const ingredients = [
    ['chicken', 'Chicken', 'food', 'g', 'kg', 1000], ['flour', 'Flour', 'food', 'g', 'kg', 1000],
    ['onion', 'Onion', 'food', 'g', 'kg', 1000], ['oil', 'Oil', 'food', 'ml', 'l', 1000],
    ['noodles', 'Noodles', 'food', 'g', 'kg', 1000], ['cabbage', 'Cabbage', 'food', 'g', 'kg', 1000],
    ['coke', 'Coke bottle', 'beverage', 'bottle', 'bottle', 1], ['whisky', 'Whisky 750ml', 'liquor', 'ml', 'bottle', 750],
  ];
  for (const [key, name, group, unit, purchaseUnit, factor] of ingredients) {
    let item = await db.get('SELECT id FROM inventory_items WHERE item_name=?', [`[DEMO] ${name}`]);
    if (!item) item = { id: number(await db.run(`INSERT INTO inventory_items(item_name,name,category_id,category,unit,consumption_unit,purchase_unit,conversion_factor,quantity,cost_per_unit,is_archived)
      VALUES (?,?,?,?,?,?,?,?,0,0,0)`, [`[DEMO] ${name}`, `[DEMO] ${name}`, categories[group].inventory, `[DEMO] ${group}`, unit, unit, purchaseUnit, factor])) };
    stock[key] = item.id;
  }
  const menu = {};
  for (const [key, name, group, price, usage] of [['momo', 'Chicken Momo', 'food', 220, 1], ['chowmein', 'Veg Chowmein', 'food', 180, 1], ['coke', 'Coke', 'beverage', 100, 1], ['whisky', 'Whisky 30ml', 'liquor', 220, 30]]) {
    let item = await db.get('SELECT id FROM menu_items WHERE name=?', [`[DEMO] ${name}`]);
    if (!item) item = { id: number(await db.run('INSERT INTO menu_items(name,category_id,base_price,stock_usage,is_available) VALUES (?,?,?,?,1)', [`[DEMO] ${name}`, categories[group].menu, price, usage])) };
    menu[key] = { id: item.id, name: `[DEMO] ${name}`, price };
    if (key === 'coke' || key === 'whisky') await db.run('UPDATE inventory_items SET menu_item_id=? WHERE id=?', [item.id, stock[key]]);
  }
  for (const [key, lines] of [['momo', [['chicken', 100], ['flour', 100], ['onion', 30], ['oil', 10]]], ['chowmein', [['noodles', 150], ['cabbage', 60], ['onion', 20], ['oil', 15]]]]) {
    if (!(await db.get('SELECT id FROM recipes WHERE menu_item_id=?', [menu[key].id]))) await createRecipe(db, {
      name: `${menu[key].name} recipe`, type: 'menu_item', menu_item_id: menu[key].id, yield_quantity: 1, yield_unit: 'plate',
      items: lines.map(([ingredient, quantity]) => ({ raw_material_id: stock[ingredient], quantity, unit: ingredient === 'oil' ? 'ml' : 'g' })),
    });
  }

  async function retimeExpense(sourceType, sourceId, date, hour) {
    const expense = await db.get('SELECT id FROM expenses WHERE source_type=? AND source_id=?', [sourceType, sourceId]);
    if (!expense) return;
    await db.run('UPDATE expenses SET created_at=? WHERE id=?', [timestamp(date, hour), expense.id]);
    await db.run("UPDATE journal_entries SET created_at=? WHERE source_type='expense' AND source_id=?", [timestamp(date, hour), expense.id]);
  }
  const purchases = [
    { day: 0, group: 'food', items: [['chicken', 4, 500], ['flour', 4, 90], ['onion', 2, 80], ['oil', 1, 250], ['noodles', 3, 120], ['cabbage', 2, 60]] },
    { day: 0, group: 'beverage', items: [['coke', 24, 55]] }, { day: 0, group: 'liquor', items: [['whisky', 2, 3000]] },
    { day: 1, group: 'food', items: [['chicken', 3, 500], ['flour', 4, 90], ['onion', 2, 80], ['oil', 1, 250], ['noodles', 3, 120], ['cabbage', 2, 60]] },
    { day: 1, group: 'beverage', items: [['coke', 24, 55]] }, { day: 1, group: 'liquor', items: [['whisky', 1, 3000]] },
    { day: 2, group: 'food', items: [['chicken', 3, 500], ['flour', 4, 90]] },
    { day: 2, group: 'beverage', items: [['coke', 12, 55]] },
    { day: 2, group: 'liquor', items: [['whisky', 1, 3000]] },
  ];
  const quantities = [{ momo: 20, chowmein: 8, coke: 12, whisky: 8 }, { momo: 24, chowmein: 12, coke: 16, whisky: 12 }, { momo: 30, chowmein: 14, coke: 18, whisky: 16 }];
  for (let index = 0; index < days.length; index++) {
    const day = days[index]; const date = dates[index];
    for (const entry of purchases.filter((purchase) => purchase.day === index)) {
      const reference = `${mark}-${date}-${entry.group}`;
      if (await db.get('SELECT id FROM purchases WHERE invoice_number=?', [reference])) continue;
      const purchase = await createPurchase(db, { supplier: `[DEMO] ${entry.group === 'food' ? 'Fresh Foods' : entry.group === 'beverage' ? 'Drinks Supplier' : 'Spirits Supplier'}`,
        invoice_number: reference, invoice_date: date, payment_method: 'credit', received_by: actor.id, performed_by: actor.id,
        notes: '[DEMO] Sample purchase for the analytics preview. Not a real supplier invoice.',
        items: entry.items.map(([key, quantity, cost]) => ({ inventory_item_id: stock[key], quantity_ordered: quantity, quantity_received: quantity, unit_cost: cost })),
      });
      await db.run('UPDATE purchases SET created_at=? WHERE id=?', [timestamp(date, 9), purchase.id]);
      await db.run("UPDATE stock_movements SET created_at=? WHERE reference_id=? AND change_type='purchase_receipt'", [timestamp(date, 9), String(purchase.id)]);
      await retimeExpense('purchase', purchase.id, date, 9);
    }
    for (const [key, quantity] of Object.entries(quantities[index])) {
      const reference = `${mark}-${date}-${key}`;
      if (await db.get('SELECT id FROM bills WHERE bill_number=?', [reference])) continue;
      await db.transaction(async (tx) => {
        const item = menu[key]; const gross = quantity * item.price;
        const discount = key === 'momo' && index === 1 ? gross / 10 : 0;
        const total = gross - discount; const method = key === 'coke' || key === 'whisky' ? 'qr' : 'cash';
        const orderId = number(await tx.run(`INSERT INTO orders(order_number,order_type,status,customer_name,notes,business_day_id,created_at,payment_status,payment_method,stock_consumed)
          VALUES (?,'takeaway','completed','Demo customer','[DEMO] Analytics sample sale',?,?,'paid',?,0)`, [reference, day.id, timestamp(date, 11), method]));
        await tx.run("INSERT INTO order_items(order_id,menu_item_id,item_id,item_name,quantity,price,subtotal,status) VALUES (?,?,?,?,?,?,?,'served')", [orderId, item.id, item.id, item.name, quantity, item.price, gross]);
        const billId = number(await tx.run(`INSERT INTO bills(bill_number,order_id,subtotal,discount_amount,grand_total,tax,vat_amount,service_charge,status,payment_status,outstanding_amount,cashier_id,business_day_id,created_at,paid_at)
          VALUES (?,?,?,?,?,0,0,0,'paid','paid',0,?,?,?,?)`, [reference, orderId, gross, discount, total, actor.id, day.id, timestamp(date, 11), timestamp(date, 11)]));
        await tx.run("INSERT INTO bill_payments(bill_id,amount,payment_method,created_at) VALUES (?,?,?,?)", [billId, total, method, timestamp(date, 11)]);
        await postSaleJournal(tx, { bill_id: billId, bill_number: reference, entry_date: date, parts: [{ method, amount: total }], tax_amount: 0, created_by: actor.id, business_day_id: day.id });
        await deductStockForItems(tx, [{ menu_item_id: item.id, item_name: item.name, quantity }], { orderId, performedBy: actor.id, operationKey: reference });
        await tx.run('UPDATE orders SET stock_consumed=1 WHERE id=?', [orderId]);
        await tx.run("UPDATE stock_movements SET created_at=? WHERE reference_id=? AND change_type='order_deduction'", [timestamp(date, 11), String(orderId)]);
        await tx.run("UPDATE journal_entries SET created_at=? WHERE source_type='bill' AND source_id=?", [timestamp(date, 11), billId]);
      });
    }
    if (index > 0 && !(await db.get('SELECT id FROM wastage_log WHERE notes=?', [`${mark}-${date}-waste`]))) {
      const loss = await logWastage(db, { raw_material_id: index === 1 ? stock.chicken : stock.coke,
        quantity: index === 1 ? 200 : 1, unit: index === 1 ? 'g' : 'bottle', reason: index === 1 ? 'expired' : 'dropped',
        logged_by: actor.id, business_day_id: day.id, notes: `${mark}-${date}-waste` });
      await db.run('UPDATE wastage_log SET created_at=? WHERE id=?', [timestamp(date, 12), loss.id]);
      await db.run("UPDATE stock_movements SET created_at=? WHERE reference_id=? AND change_type='wastage'", [timestamp(date, 12), String(loss.id)]);
      await retimeExpense('wastage', loss.id, date, 12);
    }
    if (day.status === 'closed' && day.opening_note?.includes('[DEMO]')) {
      const summary = await businessDaySummary(db, day);
      const expected = summary.cash.expected_cash;
      await db.run('UPDATE business_days SET expected_cash=?,counted_cash=?,cash_difference=0,closing_snapshot=? WHERE id=?', [expected, expected, JSON.stringify(summary), day.id]);
      await db.run('UPDATE business_day_sessions SET expected_cash=?,counted_cash=?,cash_difference=0,closing_snapshot=? WHERE business_day_id=?', [expected, expected, JSON.stringify(summary), day.id]);
    }
  }
  const report = await buildPurchaseSalesAnalysis(db, { start: today, end: today }, { businessDayId: active.id }, { page: 1, pageSize: 50, sort: 'name', dir: 'ASC' });
  console.log(JSON.stringify({ database: target, backup, businessDays: days.map((day) => ({ id: day.id, date: day.business_date, status: day.status })),
    report: `/admin/purchase-vs-sales?businessDayId=${active.id}`, totals: report.totals }, null, 2));
} finally { db.close(); }
