import { NextResponse } from 'next/server';
import Database from '@/lib/db/index.js';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { ensureReportSchema, dateKey, billScope } from '@/lib/reports.js';
import { ensureRecipeTables, getRecipeByMenuItemId, getRecipeWithItems, getRecipeCost } from '@/lib/recipes.js';
import { ensureInventoryCategorySchema } from '@/lib/inventory-categories.js';
import { columnExists } from '@/lib/db/schema-helpers.js';
import { currentBusinessDay } from '@/lib/business-days.js';
import { resolvePeriodRange } from '@/lib/report-dates.js';
import { buildPurchaseSalesAnalysis, purchaseAnalysisScope, analysisMasterGroups } from '@/lib/purchase-sales-analysis.js';
import { analysisExport } from '@/lib/analysis-export.js';
import { readListParams, paginateQuery } from '@/lib/paginate.js';
import { analysisCharts } from '@/lib/analysis-charts.js';
import { analysisReconciliation } from '@/lib/analysis-reconciliation.js';
import { foodGroupSql, normalizeFoodGroup } from '@/lib/food-groups.js';
import { inventoryCategoryMasters } from '@/lib/inventory-master.js';

const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
function optionalId(query, key) {
  const value = query.get(key);
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < (key === 'categoryId' ? 0 : 1)) bad(`Invalid ${key}.`);
  return id;
}

export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'report.profitability.view' });
    if (auth.error) return auth.error;
    const q = new URL(request.url).searchParams;
    const mode = q.get('mode') || 'combined';
    const level = q.get('level') || 'master';
    if (!['combined', 'purchases', 'sales', 'inventory'].includes(mode) || !['master', 'category', 'item'].includes(level)) bad('Invalid report view.');
    if (q.get('period') === 'custom') {
      for (const key of ['startDate', 'endDate']) {
        const value = q.get(key) || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) bad('Choose valid custom dates.');
      }
    }
    const db = Database.getInstance();
    // Production requires the migration, rather than silently reporting incomplete schema.
    if (db.driver === 'postgres' && !(await columnExists(db, 'stock_movements', 'consumption_key'))) {
      throw Object.assign(new Error('Apply migration 074_purchase_consumption_analytics before opening this report.'), { status: 503, expose: true });
    }
    await ensureReportSchema(db);
    await ensureRecipeTables(db);
    await ensureInventoryCategorySchema(db);
    const range = resolvePeriodRange(q.get('period') || 'today', q.get('startDate'), q.get('endDate'), { calendarSystem: q.get('calendarSystem') });
    const filters = { businessDayId: optionalId(q, 'businessDayId'), supplierId: optionalId(q, 'supplierId'),
      categoryId: optionalId(q, 'categoryId'), itemId: optionalId(q, 'itemId'), master: q.get('master') ? normalizeFoodGroup(q.get('master')) : '', search: (q.get('search') || '').trim().slice(0, 200) };
    if (!filters.businessDayId && range.period === 'today') filters.businessDayId = (await currentBusinessDay(db))?.id || null;
    if (filters.businessDayId) {
      const day = await db.get('SELECT * FROM business_days WHERE id = ?', [filters.businessDayId]);
      if (!day) return NextResponse.json({ error: 'Business day not found.' }, { status: 404 });
      range.start = dateKey(day.business_date); range.end = range.start; range.label = `Business day ${range.start} (#${day.id})`;
    }
    if (filters.supplierId && mode !== 'purchases') bad('Supplier filtering applies to Purchase Analysis only.');
    if (mode === 'combined' && (filters.categoryId != null || filters.itemId)) bad('Choose the purchase or sales hierarchy before selecting a category or item.');
    const list = readListParams(q, { defaultDir: 'asc' });
    const format = q.get('format');
    if (format && !['csv', 'xls'].includes(format)) bad('Invalid export format.');
    if (format) list.exportAll = true;
    const basis = mode === 'combined' ? 'Purchases: invoice date · Sales: recorded bill date (Nepal)'
      : mode === 'purchases' ? 'Purchase invoice date (Nepal entry date when absent)' : 'Recorded transaction date (Nepal)';
    const context = { range, filters, basis: filters.businessDayId ? 'Assigned business day' : basis };
    if (q.get('detail')) {
      if (!filters.itemId || mode === 'combined') bad('Select an item for transaction details.');
      const detail = await itemDetails(db, range, filters, list, mode);
      return NextResponse.json({ ...context, ...detail }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const report = await buildPurchaseSalesAnalysis(db, range, filters, list, mode, level);
    if (format) {
      const file = analysisExport(report, format, context);
      return new NextResponse(file.body, { headers: { 'Content-Type': file.type,
        'Content-Disposition': `attachment; filename="${mode}-analysis-${range.start}.${file.extension}"`, 'Cache-Control': 'private, no-store' } });
    }
    const [suppliers, businessDays, charts, reconciliation, categories, masterGroups] = await Promise.all([
      db.all('SELECT id, name FROM suppliers ORDER BY name'),
      db.all('SELECT id, business_date, status, opening_note FROM business_days ORDER BY business_date DESC, id DESC LIMIT 90'),
      q.get('charts') === '1' ? analysisCharts(db, range, filters, mode) : null,
      ['combined', 'purchases'].includes(mode) ? analysisReconciliation(db, range, filters) : null,
      mode === 'combined' ? [] : mode === 'sales'
        ? db.all(`SELECT c.id, c.name, ${foodGroupSql('c')} AS master FROM menu_categories c WHERE c.is_active = 1 ORDER BY c.name`)
        : inventoryCategoryMasters(db),
      analysisMasterGroups(db, mode),
    ]);
    return NextResponse.json({ ...context, ...report, suppliers, businessDays, categories, masterGroups, charts, reconciliation }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return handleRouteError(error, 'Could not build purchase and consumption analysis.'); }
}

async function itemDetails(db, range, filters, list, mode) {
  if (mode === 'purchases') {
    const scope = purchaseAnalysisScope(range, filters);
    const where = ['pi.inventory_item_id = ?', "p.status IN ('received','partial')", scope.sql];
    const params = [filters.itemId, ...scope.params];
    if (filters.supplierId) { where.push('p.supplier_id = ?'); params.push(filters.supplierId); }
    return paginateQuery(db, { columns: 'pi.*, p.invoice_number, p.invoice_date, p.created_at AS recorded_at, p.supplier',
      from: 'purchase_items pi JOIN purchases p ON p.id = pi.purchase_id', where: where.join(' AND '), params,
      orderBy: 'p.created_at DESC, pi.id DESC', ...list });
  }
  const scope = billScope(db, range, { businessDayId: filters.businessDayId });
  const result = await paginateQuery(db, { columns: 'm.*, ii.item_name AS ingredient, ii.consumption_unit AS unit',
    from: 'stock_movements m LEFT JOIN inventory_items ii ON ii.id = m.inventory_item_id',
    where: `m.sale_menu_item_id = ? AND m.change_type IN ('order_deduction','order_void') AND EXISTS (
      SELECT 1 FROM bills b JOIN orders o ON o.id = b.order_id ${scope.sql} AND CAST(o.id AS TEXT) = m.reference_id)`,
    params: [filters.itemId, ...scope.params], orderBy: 'm.created_at DESC, m.id DESC', ...list });
  const recipe = await getRecipeByMenuItemId(db, filters.itemId);
  const currentRecipe = recipe ? { ...await getRecipeWithItems(db, recipe.id), cost: await getRecipeCost(db, recipe.id), basis: 'Current recipe preview only; not historical COGS' } : null;
  return { ...result, currentRecipe };
}
