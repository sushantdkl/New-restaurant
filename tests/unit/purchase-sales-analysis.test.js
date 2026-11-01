import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '@/lib/db/index.js';
import { ensureReportSchema, buildReport } from '@/lib/reports.js';
import { analysisReconciliation } from '@/lib/analysis-reconciliation.js';
import { ensureRecipeTables, createRecipe, updateRecipe, explodeRecipe } from '@/lib/recipes.js';
import { ensureInventoryCategorySchema, updateInventoryCategory } from '@/lib/inventory-categories.js';
import { inventoryMaster, inventoryMasterSql, inventoryCategoryMasters } from '@/lib/inventory-master.js';
import { buildAnalysisPrintHtml } from '@/lib/analysis-print.js';
import { analysisCharts } from '@/lib/analysis-charts.js';
import { deductStockForItems, restoreStockForItems } from '@/lib/stock.js';
import { buildPurchaseSalesAnalysis, analysisMasterGroups, paisa, profitability } from '@/lib/purchase-sales-analysis.js';
import { FOOD_GROUPS, foodGroupLabel, normalizeFoodGroup } from '@/lib/food-groups.js';
import { analysisExport } from '@/lib/analysis-export.js';
import { permissionForStaffPath } from '@/lib/staff-access-policy.js';
import { isPermissionAllowedSync } from '@/lib/permissions.js';
import { ensureMenuVariantsSchema } from '@/lib/menu-variants.js';

const range = { start: '2040-01-01', end: '2040-01-01', label: 'Fixture day' };
const list = { page: 1, pageSize: 50, exportAll: false, sort: 'name', dir: 'ASC' };
async function fixture(t) {
  const file = path.join(os.tmpdir(), `purchase-analysis-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const db = new PosDatabase(file);
  t.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });
  await ensureReportSchema(db); await ensureRecipeTables(db); await ensureInventoryCategorySchema(db);
  const ic = await db.run("INSERT INTO inventory_categories(name, normalized_name, food_group) VALUES ('Analytics Spirits','analytics spirits','liquor')");
  const mc = await db.run("INSERT INTO menu_categories(name, food_group) VALUES ('Analytics Pours','liquor')");
  const menu = await db.run("INSERT INTO menu_items(name, category_id, base_price, stock_usage) VALUES ('Analytics Whisky 30ml',?,220,30)", [mc.lastInsertRowid]);
  const stock = await db.run(`INSERT INTO inventory_items(item_name, name, quantity, unit, consumption_unit, purchase_unit,
    conversion_factor, cost_per_unit, category_id, menu_item_id) VALUES ('Analytics Whisky','Analytics Whisky',7500,'ml','ml','bottle',750,4,?,?)`, [ic.lastInsertRowid, menu.lastInsertRowid]);
  const order = await db.run("INSERT INTO orders(order_number, order_type, status, created_at) VALUES (?, 'dine_in','completed','2040-01-01 08:00:00')", [`AN-${Date.now()}`]);
  await db.run("INSERT INTO order_items(order_id, menu_item_id, item_id, item_name, quantity, price, subtotal, status) VALUES (?,?,?,'Analytics Whisky 30ml',20,220,4400,'active')", [order.lastInsertRowid, menu.lastInsertRowid, menu.lastInsertRowid]);
  await db.run("INSERT INTO bills(bill_number,order_id,subtotal,discount_amount,grand_total,refunded_amount,status,created_at) VALUES (?, ?,4400,400,4000,400,'paid','2040-01-01 08:00:00')", [`AB-${Date.now()}`, order.lastInsertRowid]);
  return { db, menuId: Number(menu.lastInsertRowid), stockId: Number(stock.lastInsertRowid), orderId: Number(order.lastInsertRowid), categoryId: Number(ic.lastInsertRowid) };
}

test('paisa rounding and unavailable profitability never fabricate gross profit', () => {
  assert.equal(paisa('10.075'), 1008n); assert.equal(paisa('-0.005'), -1n);
  assert.equal(profitability({ net_sales: '0', consumption_cost: '12.30' }).gross_margin, null);
  assert.equal(profitability({ net_sales: '100', consumption_cost: null, missing_mapping: 1 }).gross_profit, null);
  assert.equal(profitability({ net_sales: '0.30', consumption_cost: '0.10' }).gross_profit, '0.20');
  assert.equal(profitability({ net_sales: '0.30', consumption_cost: '0.10' }).gross_margin, 66.67);
});

test('legacy liquor assignments group under Beverages and unused masters are absent from filters', async (t) => {
  const { db, categoryId } = await fixture(t);
  for (const value of ['liquor', 'alcohol', 'alcoholic', 'LIQUOR']) {
    assert.equal(normalizeFoodGroup(value), 'beverage');
    assert.equal(foodGroupLabel(value), 'Beverages');
    assert.equal(inventoryMaster({ food_group: value }), 'beverage');
  }
  assert.equal(FOOD_GROUPS.some((group) => group.id === 'liquor'), false);
  for (const mode of ['combined', 'purchases', 'sales', 'inventory']) {
    const groups = await analysisMasterGroups(db, mode);
    assert.ok(groups.some((group) => group.id === 'beverage'), mode);
    assert.equal(groups.some((group) => group.id === 'liquor'), false);
  }
  await db.run('UPDATE menu_categories SET is_active=0');
  assert.deepEqual(await analysisMasterGroups(db, 'sales'), []);
  await db.run('UPDATE inventory_items SET is_archived=1');
  assert.deepEqual(await analysisMasterGroups(db, 'purchases'), []);
  assert.equal(inventoryMaster({ name: 'Alcohol' }), 'beverage');
  await updateInventoryCategory(db, categoryId, 'Spirits', 'beverage');
});

test('portion deductions snapshot cost; SQL sales allocates discounts/refunds once and survives later cost changes', async (t) => {
  const { db, menuId, stockId, orderId } = await fixture(t);
  await db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 20 }], { orderId }));
  await db.run("UPDATE stock_movements SET created_at='2040-01-01 08:00:00' WHERE reference_id=?", [String(orderId)]);
  await db.run('UPDATE inventory_items SET cost_per_unit=99 WHERE id=?', [stockId]);
  const report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'sales', 'item');
  assert.equal(report.rows.length, 1);
  assert.equal(Number(report.rows[0].consumption_cost), 2400);
  assert.equal(Number(report.rows[0].net_sales), 3600);
  assert.equal(report.rows[0].gross_profit, '1200.00');
  assert.equal(report.rows[0].gross_margin, 33.33);
  assert.equal(report.rows[0].actual_posted_cogs, null);
  const movements = await db.all('SELECT * FROM stock_movements WHERE reference_id=?', [String(orderId)]);
  assert.equal(movements[0].quantity_changed, -600); assert.equal(movements[0].sold_quantity, 20);
  assert.equal(movements[0].sale_menu_item_id, menuId);
});

test('legacy and partially attributed sales show unavailable cost rather than current recipe estimates', async (t) => {
  const { db, menuId, orderId } = await fixture(t);
  let report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'sales', 'master');
  assert.equal(report.rows[0].gross_profit, null);
  await db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 1 }], { orderId }));
  report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'sales', 'master');
  assert.equal(report.rows[0].consumption_cost, null);
  assert.equal(Number(report.rows[0].missing_mapping), 1);
});

test('purchases retain inventory hierarchy, separate tax/discount/shipping, and paginate/export full groups', async (t) => {
  const { db, stockId } = await fixture(t);
  const supplier = await db.run("INSERT INTO suppliers(name, normalized_name) VALUES ('Analytics supplier','analytics supplier')");
  const p = await db.run(`INSERT INTO purchases(supplier_id,supplier,subtotal,tax,discount,shipping,total,status,created_at)
    VALUES (?,'Analytics supplier',3000,390,300,60,3150,'received','2040-01-01 08:00:00')`, [supplier.lastInsertRowid]);
  await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_received,unit_cost,line_total) VALUES (?,?,1,3000,3000)', [p.lastInsertRowid, stockId]);
  const report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage', supplierId: supplier.lastInsertRowid }, { ...list, pageSize: 1 }, 'purchases', 'item');
  assert.equal(Number(report.totals.net_purchases), 3150); assert.equal(Number(report.totals.purchase_tax), 390);
  assert.equal(report.rows[0].name, 'Analytics Whisky'); assert.equal(report.rows[0].unit, 'bottle');
  assert.equal(Number(report.rows[0].purchased_quantity), 1);
  const csv = analysisExport(report, 'csv', { range, basis: 'Transaction date' });
  assert.match(csv.body, /TOTAL/); assert.match(csv.body, /3150/);
  const xls = analysisExport({ ...report, rows: [{ name: '=EVIL<&>' }] }, 'xls', { range, basis: 'Transaction date' });
  assert.match(xls.body, /ss:Type="String">=EVIL&lt;&amp;&gt;/);
  await db.run("UPDATE inventory_items SET category_id=NULL, category='Unmanaged legacy text' WHERE id=?", [stockId]);
  const unmapped = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'category');
  assert.equal(unmapped.rows[0].id, '0'); assert.equal(unmapped.rows[0].name, 'Uncategorised');
});

test('late invoices reconcile Purchases Report, analysis, daily charts and source checks by invoice date', async (t) => {
  const { db, stockId } = await fixture(t);
  const insert = async (invoiceDate, recordedAt, status = 'received') => {
    const p = await db.run(`INSERT INTO purchases(invoice_date,created_at,subtotal,tax,discount,shipping,total,status)
      VALUES (?,?,100,13,10,2,105,?)`, [invoiceDate, recordedAt, status]);
    await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_received,unit_cost,line_total) VALUES (?,?,1,100,100)', [p.lastInsertRowid, stockId]);
    return p.lastInsertRowid;
  };
  const late = await insert('2040-01-01', '2040-02-02 08:00:00');
  await insert('2040-02-01', '2040-01-01 08:00:00'); // Entry in range, invoice outside.
  await insert(null, '2039-12-31 18:15:00'); // Nepal midnight fallback.
  await insert(null, '2040-01-01 18:15:00'); // Next Nepal day, excluded.
  await insert('2040-01-01', '2040-02-02 08:00:00', 'voided');
  const purchases = await buildReport(db, 'purchases', range, {});
  const analysis = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'master');
  const combined = await buildPurchaseSalesAnalysis(db, range, {}, list);
  assert.equal(Number(analysis.totals.net_purchases), 210);
  assert.equal(Number(combined.totals.net_purchases), 210);
  assert.equal(purchases.tables[0].totals.total, 210);
  const charts = await analysisCharts(db, range, {}, 'purchases');
  assert.equal(Number(charts.days[0].purchased), 210);
  assert.equal(String(charts.days[0].id).slice(0, 10), range.start);
  assert.equal(Number((await analysisReconciliation(db, range, {})).invoice_total), 210);
  const day = await db.run("INSERT INTO business_days(business_date,status) VALUES ('2040-02-02','closed')");
  await db.run(`INSERT INTO expenses(description,category,amount,expense_date,source_type,source_id,business_day_id)
    VALUES ('Late invoice','inventory_purchase',105,'2040-02-02','purchase',?,?)`, [late, day.lastInsertRowid]);
  const assigned = await buildPurchaseSalesAnalysis(db, range, { businessDayId: day.lastInsertRowid }, list, 'purchases', 'item');
  assert.equal(Number(assigned.totals.net_purchases), 105, 'Explicit business day overrides invoice dates');
});

test('recipe versions, yield, units and loss are retained; restoration uses original snapshot', async (t) => {
  const { db, menuId, stockId, orderId } = await fixture(t);
  await db.run('UPDATE inventory_items SET menu_item_id=NULL WHERE id=?', [stockId]);
  const recipe = await createRecipe(db, { name: 'Analytics recipe', type: 'menu_item', menu_item_id: menuId,
    yield_quantity: 2, items: [{ raw_material_id: stockId, quantity: 0.06, unit: 'l', loss_percent: 10 }] });
  assert.equal(recipe.version, 1);
  const exploded = await explodeRecipe(db, recipe.id, 1);
  assert.ok(Math.abs(exploded.get(stockId) - 66) < 0.00001);
  await db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 2 }], { orderId }));
  await updateRecipe(db, recipe.id, { name: 'Updated recipe', type: 'menu_item', menu_item_id: menuId,
    yield_quantity: 1, items: [{ raw_material_id: stockId, quantity: 500, unit: 'ml' }] });
  const versions = await db.all('SELECT * FROM recipe_versions WHERE recipe_id=?', [recipe.id]);
  assert.equal(versions.length, 2);
  await db.transaction((tx) => restoreStockForItems(tx, [{ menu_item_id: menuId, quantity: 2 }], { orderId }));
  let item = await db.get('SELECT quantity FROM inventory_items WHERE id=?', [stockId]);
  assert.ok(Math.abs(item.quantity - 7500) < 0.00001);
  // Repeated restoration cannot add more inventory than the recorded deductions.
  await db.transaction((tx) => restoreStockForItems(tx, [{ menu_item_id: menuId, quantity: 2 }], { orderId }));
  item = await db.get('SELECT quantity FROM inventory_items WHERE id=?', [stockId]);
  assert.ok(Math.abs(item.quantity - 7500) < 0.00001);
});

test('last 30ml variant pour consumes 30ml even when its usage equals the remaining stock', async (t) => {
  const { db, menuId, stockId, orderId } = await fixture(t);
  await ensureMenuVariantsSchema(db);
  await db.run('UPDATE inventory_items SET quantity=30, menu_item_id=NULL WHERE id=?', [stockId]);
  await db.run("INSERT INTO menu_item_variants(menu_item_id,variant_name,price,inventory_item_id,stock_quantity,stock_unit) VALUES (?,'30ml',220,?,30,'ml')", [menuId, stockId]);
  const result = await db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, variant_name: '30ml', quantity: 1 }], { orderId }));
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [stockId])).quantity), 0);
  assert.equal(result.deducted[0].cost_value, 120);
});

test('new confidential report permission is denied for staff by default and guards every cashier page', () => {
  for (const role of ['waiter', 'kitchen', 'cashier']) assert.equal(isPermissionAllowedSync(role, 'report.profitability.view'), false);
  for (const route of ['purchase-analysis', 'purchase-vs-sales', 'sales-recipe-cost', 'inventory-consumption']) {
    assert.equal(permissionForStaffPath(`/cashier/${route}`), 'report.profitability.view');
  }
});

test('legacy inventory categories reconcile purchase and combined masters, including filtered drilldowns and overrides', async (t) => {
  const { db, stockId, categoryId } = await fixture(t);
  await db.run('UPDATE inventory_items SET menu_item_id=NULL WHERE id=?', [stockId]);
  // Existing production categories have names but no newly introduced master assignment.
  const cases = [['Alcohol', 'beverage'], ['Baverages', 'beverage'], ['Meat/Fish', 'food'],
    ['Grocery / Raw Materialspc', 'food'], ['vegatables/fruits', 'food'],
    ['Packaging Materials', 'other'], ['Tobacco Items', 'tobacco'], ['Unknown custom category', 'uncategorised']];
  const p = await db.run(`INSERT INTO purchases(subtotal,tax,discount,shipping,total,status,created_at)
    VALUES (100,0,0,0,100,'received','2040-01-01 08:00:00')`);
  await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_received,unit_cost,line_total) VALUES (?,?,1,100,100)', [p.lastInsertRowid, stockId]);
  for (const [name, expected] of cases) {
    await db.run('UPDATE inventory_categories SET name=?, food_group=NULL WHERE id=?', [name, categoryId]);
    assert.equal(inventoryMaster({ name }), expected);
    const picker = await db.get(`SELECT ${inventoryMasterSql('c')} AS master FROM inventory_categories c WHERE c.id=?`, [categoryId]);
    assert.equal(picker.master, expected);
    const combined = await buildPurchaseSalesAnalysis(db, range, {}, list, 'combined');
    assert.equal(Number(combined.rows.find((r) => r.master === expected)?.net_purchases), 100, name);
    const purchases = await buildPurchaseSalesAnalysis(db, range, { master: expected }, list, 'purchases', 'category');
    assert.equal(purchases.rows[0].name, name);
    assert.equal(Number(purchases.totals.net_purchases), Number(combined.totals.net_purchases));
    const inventory = await buildPurchaseSalesAnalysis(db, range, { master: expected }, list, 'inventory', 'category');
    assert.equal(inventory.rows[0].name, name);
  }
  for (const saved of ['beverages', 'food', 'uncategorised']) {
    await db.run("UPDATE inventory_categories SET name='Alcohol', food_group=? WHERE id=?", [saved, categoryId]);
    const expected = saved === 'beverages' ? 'beverage' : saved;
    const report = await buildPurchaseSalesAnalysis(db, range, { master: expected }, list, 'purchases', 'master');
    assert.equal(Number(report.totals.net_purchases), 100);
    assert.equal(inventoryMaster({ name: 'Alcohol', food_group: saved }), expected);
  }
  await updateInventoryCategory(db, categoryId, 'Alcohol', 'uncategorised');
  assert.equal((await db.get('SELECT food_group FROM inventory_categories WHERE id=?', [categoryId])).food_group, 'uncategorised');
});

test('inventory distinguishes deductions from restorations and counts only incomplete usage movements', async (t) => {
  const { db, stockId } = await fixture(t);
  const movement = async (type, qty, cost) => db.run(`INSERT INTO stock_movements
    (inventory_item_id, change_type, quantity_changed, unit_cost, created_at) VALUES (?,?,?,?,'2040-01-01 08:00:00')`, [stockId, type, qty, cost]);
  await movement('order_deduction', -10, 4);
  await movement('order_void', 15, 4);
  await movement('purchase', 10, null);
  let report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'inventory', 'category');
  assert.equal(Number(report.totals.stock_deducted), 40);
  assert.equal(Number(report.totals.stock_restored), 60);
  assert.equal(Number(report.totals.inventory_consumed), -20);
  assert.equal(Number(report.totals.unpriced_movements), 0);
  await movement('order_deduction', -1, 0);
  await movement('wastage', -1, null);
  report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'inventory', 'category');
  assert.equal(Number(report.totals.unpriced_movements), 2);
});

async function purchaseFixture(db, stockIds) {
  const value = stockIds.length * 100;
  const p = await db.run(`INSERT INTO purchases(subtotal,tax,discount,shipping,total,status,created_at)
    VALUES (?,0,0,0,?,'received','2040-01-01 08:00:00')`, [value, value]);
  for (const id of stockIds) await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_received,unit_cost,line_total) VALUES (?,?,1,100,100)', [p.lastInsertRowid, id]);
}

async function menuFixture(db, name, master) {
  const category = await db.run('INSERT INTO menu_categories(name, food_group) VALUES (?,?)', [name, master]);
  const menu = await db.run('INSERT INTO menu_items(name,category_id,base_price) VALUES (?,?,100)', [name, category.lastInsertRowid]);
  return Number(menu.lastInsertRowid);
}

test('combined master drilldown uses menu, variant and nested recipe links without duplicating purchases', async (t) => {
  const { db, stockId, categoryId, menuId, orderId } = await fixture(t);
  const variantMenu = await menuFixture(db, 'Linked Beer', 'beverage');
  const coffeeMenu = await menuFixture(db, 'Linked Coffee', 'beverage');
  const teaMenu = await menuFixture(db, 'Linked Tea', 'beverage');
  const foodMenu = await menuFixture(db, 'Different master', 'food');
  const stock = async (name) => Number((await db.run(`INSERT INTO inventory_items(item_name,name,quantity,unit,cost_per_unit,category_id)
    VALUES (?,?,100,'ml',2,?)`, [name, name, categoryId])).lastInsertRowid);
  const beer = await stock('Beer stock');
  const shared = await stock('Shared milk');
  const unlinked = await stock('Linked Coffee'); // Matching names alone do not create a link.
  await db.run('UPDATE inventory_items SET menu_item_id=? WHERE id=?', [foodMenu, unlinked]);
  for (const variant of ['Small', 'Large']) await db.run(`INSERT INTO menu_item_variants(menu_item_id,variant_name,inventory_item_id)
    VALUES (?,?,?)`, [variantMenu, variant, beer]);
  const sub = await createRecipe(db, { name: 'Shared milk subrecipe', type: 'sub_recipe', yield_quantity: 1,
    items: [{ raw_material_id: shared, quantity: 1, unit: 'ml' }] });
  for (const menu of [coffeeMenu, teaMenu]) await createRecipe(db, { name: `Linked recipe ${menu}`, type: 'menu_item', menu_item_id: menu,
    yield_quantity: 1, items: [{ component_recipe_id: sub.id, quantity: 1 }] });
  await purchaseFixture(db, [stockId, beer, shared, unlinked]);
  await db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 20 }], { orderId }));
  const master = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list);
  const drilldown = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'combined', 'category');
  assert.equal(drilldown.level, 'category');
  assert.deepEqual(drilldown.rows.map((row) => [row.name, Number(row.net_purchases)]), [
    ['Analytics Pours', 100], ['Linked Beer', 100], ['Shared stock', 100], ['Unlinked stock', 100],
  ]);
  assert.equal(drilldown.totals.net_purchases, master.totals.net_purchases);
  assert.equal(drilldown.totals.net_sales, master.totals.net_sales);
  assert.equal(drilldown.totals.consumption_cost, master.totals.consumption_cost);
  assert.equal(drilldown.totals.gross_profit, master.totals.gross_profit);
  assert.equal(drilldown.rows[0].gross_profit, '1200.00');
  const csv = analysisExport(drilldown, 'csv', { range, basis: '' });
  assert.match(csv.body, /Linked Beer/);
  assert.match(csv.body, /Shared stock/);
  for (const size of ['80', 'a4']) {
    const html = buildAnalysisPrintHtml(drilldown, { size, scope: 'Beverages' });
    assert.match(html, /<h2>Linked Beer<\/h2>/);
    assert.match(html, /<h2>Shared stock<\/h2>/);
  }
});

test('direct menu links beat category-name defaults, while saved inventory assignments override links', async (t) => {
  const { db, stockId, categoryId, menuId } = await fixture(t);
  await db.run("UPDATE inventory_categories SET name='Meat/Fish',food_group=NULL WHERE id=?", [categoryId]);
  await purchaseFixture(db, [stockId]);
  let report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'combined');
  assert.equal(Number(report.rows.find((r) => r.master === 'beverage').net_purchases), 100);
  assert.equal(Number(report.totals.net_purchases), 100);
  let items = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage', categoryId }, list, 'purchases', 'item');
  assert.equal(items.rows[0].mapping_source, 'Linked menu items / recipes');
  assert.equal(items.rows[0].id, String(stockId));
  const picker = (await inventoryCategoryMasters(db)).find((c) => c.id === categoryId);
  assert.deepEqual(picker.masters, ['beverage']);
  await updateInventoryCategory(db, categoryId, 'Meat/Fish', 'other');
  items = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'item');
  assert.equal(items.rows[0].master, 'other');
  assert.equal(items.rows[0].mapping_source, 'Inventory assignment');
  report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'purchases', 'master');
  assert.equal(report.rows.length, 0);
  await db.run('UPDATE inventory_categories SET food_group=NULL WHERE id=?', [categoryId]);
  await db.run("UPDATE menu_categories SET food_group='uncategorised' WHERE id=(SELECT category_id FROM menu_items WHERE id=?)", [menuId]);
  items = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'item');
  assert.equal(items.rows[0].master, 'uncategorised');
  assert.equal(items.rows[0].mapping_source, 'Linked menu category missing');
});

test('variant links and nested shared recipes count purchases once; conflicting menu masters require assignment', async (t) => {
  const { db, stockId, categoryId } = await fixture(t);
  await db.run('UPDATE inventory_items SET menu_item_id=NULL WHERE id=?', [stockId]);
  // This name would otherwise imply Food. A linked conflict must not fall back to it.
  await db.run("UPDATE inventory_categories SET name='dairy products',food_group=NULL WHERE id=?", [categoryId]);
  const drink = await menuFixture(db, 'Milk drink', 'beverage');
  const drink2 = await menuFixture(db, 'Another milk drink', 'beverages');
  const dish = await menuFixture(db, 'Milk dessert', 'food');
  await db.run("INSERT INTO menu_item_variants(menu_item_id,variant_name,inventory_item_id) VALUES (?,'Small',?)", [drink, stockId]);
  await db.run("INSERT INTO menu_item_variants(menu_item_id,variant_name,inventory_item_id) VALUES (?,'Large',?)", [drink, stockId]);
  const sub = await createRecipe(db, { name: 'Milk base', type: 'sub_recipe', yield_quantity: 1,
    items: [{ raw_material_id: stockId, quantity: 1, unit: 'ml' }] });
  await createRecipe(db, { name: 'Milk drink recipe', type: 'menu_item', menu_item_id: drink2, yield_quantity: 1,
    items: [{ component_recipe_id: sub.id, quantity: 1 }, { raw_material_id: stockId, quantity: 1, unit: 'ml' }] });
  await purchaseFixture(db, [stockId]);
  let report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'master');
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].master, 'beverage');
  assert.equal(Number(report.totals.net_purchases), 100);
  assert.equal(Number(report.totals.mapping_conflicts), 0);
  const dessert = await createRecipe(db, { name: 'Dessert recipe', type: 'menu_item', menu_item_id: dish, yield_quantity: 1,
    items: [{ component_recipe_id: sub.id, quantity: 1 }] });
  report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'combined');
  assert.equal(Number(report.rows.find((r) => r.master === 'uncategorised').net_purchases), 100);
  assert.equal(Number(report.totals.net_purchases), 100);
  assert.equal(Number(report.totals.mapping_conflicts), 1);
  const items = await buildPurchaseSalesAnalysis(db, range, { master: 'uncategorised' }, list, 'purchases', 'item');
  assert.equal(items.rows[0].mapping_source, 'Shared across menu categories');
  assert.match(analysisExport(items, 'csv', { range, basis: 'Transaction date' }).body, /Shared across menu categories/);
  assert.match(buildAnalysisPrintHtml({ ...report, range }), /<h2>Uncategorised<\/h2>/);
  assert.doesNotMatch(buildAnalysisPrintHtml({ ...report, range }), /counted once under Uncategorised/);
  const picker = (await inventoryCategoryMasters(db)).find((c) => c.id === categoryId);
  assert.equal(picker.mapping_conflicts, 1);
  assert.deepEqual(picker.masters, ['uncategorised']);
  const filtered = await buildPurchaseSalesAnalysis(db, range, { master: 'food' }, list, 'purchases', 'master');
  assert.equal(filtered.rows.length, 0);
  await db.run('UPDATE recipes SET is_active=0 WHERE id=?', [dessert.id]);
  report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'master');
  assert.equal(report.rows[0].master, 'beverage');
  await db.run('UPDATE recipes SET is_active=1 WHERE id=?', [dessert.id]);
  await updateInventoryCategory(db, categoryId, 'dairy products', 'food');
  report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'item');
  assert.equal(report.rows[0].master, 'food');
  assert.equal(Number(report.totals.mapping_conflicts), 0);
});

test('inventory categories containing differently linked items stay one row and filter/drill without losing items', async (t) => {
  const { db, stockId, categoryId } = await fixture(t);
  await db.run('UPDATE inventory_categories SET food_group=NULL WHERE id=?', [categoryId]);
  const menu = await menuFixture(db, 'Food item in same stock category', 'food');
  const item = await db.run(`INSERT INTO inventory_items(item_name,name,quantity,unit,cost_per_unit,category_id,menu_item_id)
    VALUES ('Shared category food','Shared category food',10,'pcs',2,?,?)`, [categoryId, menu]);
  await purchaseFixture(db, [stockId, item.lastInsertRowid]);
  const categories = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'category');
  assert.equal(categories.rows.length, 1);
  assert.equal(categories.rows[0].master, 'mixed');
  assert.equal(Number(categories.totals.net_purchases), 200);
  const inventory = await buildPurchaseSalesAnalysis(db, range, { categoryId }, list, 'inventory', 'category');
  assert.equal(inventory.rows.length, 1);
  assert.equal(inventory.rows[0].master, 'mixed');
  assert.equal(Number(inventory.totals.stock_value), 30020);
  const picker = (await inventoryCategoryMasters(db)).find((c) => c.id === categoryId);
  assert.deepEqual(picker.masters, ['beverage', 'food']);
  for (const master of picker.masters) {
    const items = await buildPurchaseSalesAnalysis(db, range, { categoryId, master }, list, 'purchases', 'item');
    assert.equal(items.rows.length, 1);
    assert.equal(Number(items.totals.net_purchases), 100);
    const charts = await analysisCharts(db, range, { categoryId, master }, 'purchases');
    assert.equal(Number(charts.days[0].purchased), 100);
  }
});

test('recipe cycles terminate and stale recipes overridden by direct stock links do not classify their ingredients', async (t) => {
  const { db, stockId, categoryId, menuId } = await fixture(t);
  await db.run('UPDATE inventory_items SET menu_item_id=NULL WHERE id=?', [stockId]);
  await db.run("UPDATE inventory_categories SET name='Unrecognised stock category',food_group=NULL WHERE id=?", [categoryId]);
  const a = await db.run("INSERT INTO recipes(name,type) VALUES ('Legacy A','sub_recipe')");
  const b = await db.run("INSERT INTO recipes(name,type) VALUES ('Legacy B','sub_recipe')");
  const root = await db.run("INSERT INTO recipes(name,type,menu_item_id) VALUES ('Legacy root','menu_item',?)", [menuId]);
  for (const [parent, child] of [[root.lastInsertRowid, a.lastInsertRowid], [a.lastInsertRowid, b.lastInsertRowid], [b.lastInsertRowid, a.lastInsertRowid]]) {
    await db.run('INSERT INTO recipe_items(recipe_id,component_recipe_id,quantity) VALUES (?,?,1)', [parent, child]);
  }
  await db.run('INSERT INTO recipe_items(recipe_id,raw_material_id,quantity) VALUES (?,?,1)', [b.lastInsertRowid, stockId]);
  await purchaseFixture(db, [stockId]);
  let report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'item');
  assert.equal(report.rows[0].master, 'beverage');
  assert.equal(Number(report.totals.net_purchases), 100);
  await db.run(`INSERT INTO inventory_items(item_name,name,quantity,unit,cost_per_unit,menu_item_id)
    VALUES ('Actual retail link','Actual retail link',10,'pcs',2,?)`, [menuId]);
  report = await buildPurchaseSalesAnalysis(db, range, {}, list, 'purchases', 'item');
  assert.equal(report.rows[0].master, 'uncategorised');
  assert.equal(report.rows[0].mapping_source, 'Unlinked / unmapped');
});
