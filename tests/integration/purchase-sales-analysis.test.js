import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '@/lib/db/index.js';
import { ensureReportSchema } from '@/lib/reports.js';
import { ensureRecipeTables, createRecipe, updateRecipe, previewRecipe } from '@/lib/recipes.js';
import { ensureInventoryCategorySchema } from '@/lib/inventory-categories.js';
import { deductStockForItems, restoreStockForItems } from '@/lib/stock.js';
import { buildPurchaseSalesAnalysis } from '@/lib/purchase-sales-analysis.js';
import { analysisCharts } from '@/lib/analysis-charts.js';
import { analysisReconciliation } from '@/lib/analysis-reconciliation.js';
import { AuthService } from '@/lib/auth/auth.js';
import { GET as getAnalysis } from '@/app/api/admin/purchase-sales-analysis/route.js';
import { GET as getInventoryCategories } from '@/app/api/admin/inventory-categories/route.js';
import { inventoryCategoryMasters } from '@/lib/inventory-master.js';

if (!process.env.DATABASE_URL || !/^\/km_test_\d+_\d+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Run using scripts/run-integration.mjs with an isolated local PostgreSQL server.');
const db = Database.getInstance();
test.after(async () => { await Database.close(); });
const range = { start: '2040-01-01', end: '2040-01-01', label: 'Test day' };
const list = { page: 1, pageSize: 50, exportAll: false, sort: 'name', dir: 'ASC' };

test('PostgreSQL: migrations, portions, concurrent retry receipts, snapshots, refunds, drill-downs and charts', async () => {
  await ensureReportSchema(db); await ensureRecipeTables(db); await ensureInventoryCategorySchema(db);
  const ic = (await db.run("INSERT INTO inventory_categories(name,normalized_name,food_group) VALUES ('PG Spirits','pg spirits','liquor')")).lastInsertRowid;
  const mc = (await db.run("INSERT INTO menu_categories(name,food_group) VALUES ('PG Pours','liquor')")).lastInsertRowid;
  const menuId = (await db.run("INSERT INTO menu_items(name,category_id,base_price,stock_usage) VALUES ('PG Whisky 30ml',?,220,30)", [mc])).lastInsertRowid;
  const stockId = (await db.run(`INSERT INTO inventory_items(item_name,name,quantity,unit,consumption_unit,purchase_unit,conversion_factor,cost_per_unit,category_id,menu_item_id)
    VALUES ('PG Whisky','PG Whisky',7500,'ml','ml','bottle',750,4,?,?)`, [ic, menuId])).lastInsertRowid;
  const orderId = (await db.run("INSERT INTO orders(order_number,order_type,status,created_at) VALUES ('PG-ANALYTICS','dine_in','completed','2040-01-01 08:00:00')")).lastInsertRowid;
  await db.run("INSERT INTO order_items(order_id,menu_item_id,item_id,item_name,quantity,price,subtotal,status) VALUES (?,?,?,'PG Whisky 30ml',20,220,4400,'served')", [orderId, menuId, menuId]);
  await db.run("INSERT INTO bills(bill_number,order_id,subtotal,discount_amount,grand_total,refunded_amount,status,created_at) VALUES ('PG-ANALYTICS',?,4400,400,4000,400,'paid','2040-01-01 08:00:00')", [orderId]);
  const items = [{ menu_item_id: menuId, quantity: 20 }];
  const results = await Promise.all([1, 2, 3].map(() => db.transaction((tx) => deductStockForItems(tx, items, { orderId, operationKey: 'pg-concurrent-sale' }))));
  assert.equal(results.filter((r) => r.replayed).length, 2);
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [stockId])).quantity), 6900);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM stock_movements WHERE reference_id=?', [String(orderId)])).n), 1);
  await assert.rejects(db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 1 }], { orderId, operationKey: 'pg-concurrent-sale' })), /different items/);
  await db.run("UPDATE stock_movements SET created_at='2040-01-01 08:00:00' WHERE reference_id=?", [String(orderId)]);
  await db.run('UPDATE inventory_items SET cost_per_unit=99 WHERE id=?', [stockId]);
  for (const level of ['master', 'category', 'item']) {
    const report = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'sales', level);
    assert.equal(report.rows.length, 1); assert.equal(Number(report.totals.net_sales), 3600);
    assert.equal(report.rows[0].gross_profit, '1200.00'); assert.equal(Number(report.rows[0].consumption_cost), 2400);
  }
  const p = (await db.run("INSERT INTO purchases(supplier,subtotal,tax,discount,shipping,total,status,created_at) VALUES ('PG Supplier',3000,390,300,60,3150,'received','2040-01-01 08:00:00')")).lastInsertRowid;
  await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_received,unit_cost,line_total) VALUES (?,?,1,3000,3000)', [p, stockId]);
  const purchase = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'purchases', 'item');
  assert.equal(Number(purchase.totals.net_purchases), 3150);
  const combined = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list);
  assert.equal(combined.totals.gross_profit, '1200.00');
  const charts = await analysisCharts(db, range, { master: 'beverage' }, 'combined');
  assert.equal(Number(charts.days[0].sales), 3600); assert.equal(Number(charts.days[0].purchased), 3150);
  const dayId = (await db.run("INSERT INTO business_days(business_date,status) VALUES ('2040-01-01','closed')")).lastInsertRowid;
  await db.run('UPDATE orders SET business_day_id=? WHERE id=?', [dayId, orderId]);
  await db.run('UPDATE bills SET business_day_id=? WHERE order_id=?', [dayId, orderId]);
  await db.run("INSERT INTO expenses(description,category,amount,expense_date,source_type,source_id,business_day_id) VALUES ('PG purchase','inventory_purchase',3150,'2040-01-01','purchase',?,?)", [p, dayId]);
  await db.run("UPDATE purchases SET created_at='2040-02-01 08:00:00' WHERE id=?", [p]);
  const assigned = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage', businessDayId: dayId }, list, 'purchases', 'item');
  assert.equal(Number(assigned.totals.net_purchases), 3150, 'Business day is inherited from the linked expense, independent of entry date');
  const recorded = await buildPurchaseSalesAnalysis(db, range, { master: 'beverage' }, list, 'purchases', 'item');
  assert.equal(recorded.rows.length, 0);
  const checks = await analysisReconciliation(db, range, { businessDayId: dayId });
  assert.equal(Number(checks.missing_expenses), 0); assert.equal(checks.invoice_expense_difference, 0);
  assert.equal(Number(checks.journalChecks.missing_journals), 1, 'Diagnostics do not silently post a missing journal');
  await db.run('UPDATE inventory_items SET menu_item_id=NULL,cost_per_unit=4 WHERE id=?', [stockId]);
  const recipe = await createRecipe(db, { name: 'PG Recipe', type: 'menu_item', menu_item_id: menuId, yield_quantity: 2,
    items: [{ raw_material_id: stockId, quantity: 0.06, unit: 'l', loss_percent: 10 }] });
  const preview = await previewRecipe(db, { name: 'PG Preview', type: 'menu_item', yield_quantity: 2,
    items: [{ raw_material_id: stockId, quantity: 0.06, unit: 'l', loss_percent: 10 }] });
  assert.ok(Math.abs(Number(preview.total_cost) - 264) < 0.001);
  await updateRecipe(db, recipe.id, { name: 'PG Changed', type: 'menu_item', menu_item_id: menuId, yield_quantity: 1,
    items: [{ raw_material_id: stockId, quantity: 500, unit: 'ml' }] });
  await db.transaction((tx) => restoreStockForItems(tx, [{ menu_item_id: menuId, quantity: 20 }], { orderId, operationKey: 'pg-restore' }));
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [stockId])).quantity), 7500);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM recipe_versions WHERE recipe_id=?', [recipe.id])).n), 2);
  await db.run('UPDATE inventory_items SET quantity=0 WHERE id=?', [stockId]);
  await db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 1 }], { orderId, operationKey: 'pg-shortage' }));
  assert.equal(Number((await db.get('SELECT quantity FROM inventory_items WHERE id=?', [stockId])).quantity), 0);
  const shortage = await db.get("SELECT cost_status, variance FROM stock_movements WHERE reference_id=? ORDER BY id DESC LIMIT 1", [String(orderId)]);
  assert.equal(shortage.cost_status, 'Incomplete Mapping'); assert.equal(Number(shortage.variance), -500);
  await assert.rejects(db.transaction((tx) => deductStockForItems(tx, [{ menu_item_id: menuId, quantity: 1, variant_name: 'not configured' }], { orderId, operationKey: 'pg-rolled-back' }).then(() => { throw new Error('Simulated transaction failure'); })), /Simulated/);
  assert.equal(await db.get("SELECT * FROM inventory_operations WHERE operation_key='pg-rolled-back'"), undefined);
});

test('API refuses anonymous, waiter, kitchen and ungranted cashier access; exports share authorization', async (t) => {
  const anonymous = await getAnalysis(new Request('http://localhost/api/admin/purchase-sales-analysis'));
  assert.equal(anonymous.status, 401);
  for (const role of ['waiter', 'kitchen', 'cashier']) {
    const mock = t.mock.method(AuthService.prototype, 'verifySession', async () => ({ id: 1, role }));
    for (const suffix of ['', '?format=xls', '?detail=1&itemId=1']) {
      const response = await getAnalysis(new Request(`http://localhost/api/admin/purchase-sales-analysis${suffix}`, { headers: { Authorization: 'Bearer fixture' } }));
      assert.equal(response.status, 403);
    }
    mock.mock.restore();
  }
  t.mock.method(AuthService.prototype, 'verifySession', async () => ({ id: 1, role: 'admin' }));
  const response = await getAnalysis(new Request('http://localhost/api/admin/purchase-sales-analysis?mode=sales&period=custom&startDate=2040-01-01&endDate=2040-01-01&charts=1', { headers: { Authorization: 'Bearer fixture' } }));
  assert.equal(response.status, 200);
  const invalid = await getAnalysis(new Request('http://localhost/api/admin/purchase-sales-analysis?period=custom&startDate=2040-02-31&endDate=2040-03-01', { headers: { Authorization: 'Bearer fixture' } }));
  assert.equal(invalid.status, 400);
});

test('PostgreSQL: linked inventory masters reconcile across reports, filters, exports and shared recipes', async (t) => {
  const categoryId = (await db.run("INSERT INTO inventory_categories(name,normalized_name) VALUES ('PG linked stock','pg linked stock')")).lastInsertRowid;
  const menus = [];
  for (const master of ['beverage', 'food']) {
    const category = (await db.run('INSERT INTO menu_categories(name,food_group) VALUES (?,?)', [`PG linked ${master}`, master])).lastInsertRowid;
    menus.push((await db.run('INSERT INTO menu_items(name,category_id,base_price) VALUES (?,?,100)', [`PG linked ${master}`, category])).lastInsertRowid);
  }
  const stockId = (await db.run(`INSERT INTO inventory_items(item_name,name,quantity,unit,cost_per_unit,category_id)
    VALUES ('PG linked milk','PG linked milk',10,'ml',2,?)`, [categoryId])).lastInsertRowid;
  await db.run("INSERT INTO menu_item_variants(menu_item_id,variant_name,inventory_item_id) VALUES (?,'Small',?)", [menus[0], stockId]);
  await db.run("INSERT INTO menu_item_variants(menu_item_id,variant_name,inventory_item_id) VALUES (?,'Large',?)", [menus[0], stockId]);
  const purchaseId = (await db.run(`INSERT INTO purchases(subtotal,tax,discount,shipping,total,status,created_at)
    VALUES (100,0,0,0,100,'received','2040-01-01 08:00:00')`)).lastInsertRowid;
  await db.run('INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity_received,unit_cost,line_total) VALUES (?,?,1,100,100)', [purchaseId, stockId]);
  let report = await buildPurchaseSalesAnalysis(db, range, { categoryId }, list, 'purchases', 'master');
  assert.equal(report.rows[0].master, 'beverage');
  assert.equal(Number(report.totals.net_purchases), 100);
  const sub = await createRecipe(db, { name: 'PG linked sub', type: 'sub_recipe', yield_quantity: 1,
    items: [{ raw_material_id: stockId, quantity: 1, unit: 'ml' }] });
  await createRecipe(db, { name: 'PG linked food recipe', type: 'menu_item', menu_item_id: menus[1], yield_quantity: 1,
    items: [{ component_recipe_id: sub.id, quantity: 1 }] });
  report = await buildPurchaseSalesAnalysis(db, range, { categoryId }, list, 'purchases', 'category');
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].master, 'uncategorised');
  assert.equal(Number(report.totals.mapping_conflicts), 1);
  assert.equal(Number(report.totals.net_purchases), 100);
  const combined = await buildPurchaseSalesAnalysis(db, range, { master: 'uncategorised' }, list, 'combined');
  assert.equal(Number(combined.totals.net_purchases), 100);
  const inventory = await buildPurchaseSalesAnalysis(db, range, { categoryId }, list, 'inventory', 'item');
  assert.equal(inventory.rows[0].mapping_source, 'Shared across menu categories');
  assert.equal(Number(inventory.totals.stock_value), 20);
  assert.deepEqual((await inventoryCategoryMasters(db)).find((c) => c.id === Number(categoryId)).masters, ['uncategorised']);
  t.mock.method(AuthService.prototype, 'verifySession', async () => ({ id: 1, role: 'admin' }));
  const suffix = `mode=purchases&period=custom&startDate=2040-01-01&endDate=2040-01-01&categoryId=${categoryId}`;
  const request = (path) => new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer fixture' } });
  const response = await getAnalysis(request(`/api/admin/purchase-sales-analysis?${suffix}&level=item`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rows[0].mapping_source, 'Shared across menu categories');
  const csv = await getAnalysis(request(`/api/admin/purchase-sales-analysis?${suffix}&level=item&format=csv`));
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Shared across menu categories/);
  const setup = await getInventoryCategories(request('/api/admin/inventory-categories'));
  assert.equal(setup.status, 200);
  assert.equal((await setup.json()).categories.find((c) => c.id === Number(categoryId)).mapping_conflicts, 1);
  await db.run("UPDATE inventory_categories SET food_group='food' WHERE id=?", [categoryId]);
  report = await buildPurchaseSalesAnalysis(db, range, { categoryId, master: 'food' }, list, 'purchases', 'item');
  assert.equal(report.rows[0].mapping_source, 'Inventory assignment');
  assert.equal(Number(report.totals.mapping_conflicts), 0);
});
