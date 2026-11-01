import { purchaseAnalysisQuery, salesAnalysisQuery, inventoryAnalysisQuery, paisa } from '@/lib/purchase-sales-analysis.js';
import { nepalOperationalRangeBounds, nepalDateSql } from '@/lib/report-dates.js';
import { foodGroupSql } from '@/lib/food-groups.js';
import { inventoryMasterCtes } from '@/lib/inventory-master.js';

export async function analysisCharts(db, range, filters, mode) {
  const purchase = purchaseAnalysisQuery(db, range, filters, 'day');
  const sales = salesAnalysisQuery(db, range, filters, 'day');
  const top = salesAnalysisQuery(db, range, filters, 'item');
  const ingredients = inventoryAnalysisQuery(db, range, filters, 'item');
  // A category id belongs to only one of the two hierarchies.
  const includePurchase = ['combined', 'purchases'].includes(mode);
  const includeSales = ['combined', 'sales'].includes(mode);
  const bounds = nepalOperationalRangeBounds(db.driver, range.start, range.end);
  const wasteParams = filters.businessDayId ? [filters.businessDayId] : [bounds.start, bounds.endExclusive];
  const wasteWhere = filters.businessDayId ? 'w.business_day_id = ?' : 'w.created_at >= ? AND w.created_at < ?';
  let wasteFilter = '';
  if (filters.master) {
    wasteFilter += ` AND CASE WHEN ii.id IS NOT NULL THEN COALESCE(im.master, 'uncategorised') ELSE ${foodGroupSql('mc')} END = ?`;
    wasteParams.push(filters.master);
  }
  const [purchaseDays, saleDays, topItems, highConsumption, wastage] = await Promise.all([
    includePurchase ? db.all(`SELECT id, SUM(net_purchases) AS purchased FROM (${purchase.sql}) days GROUP BY id ORDER BY id LIMIT 366`, purchase.params) : [],
    includeSales ? db.all(`SELECT id, SUM(net_sales) AS sales FROM (${sales.sql}) days GROUP BY id ORDER BY id LIMIT 366`, sales.params) : [],
    includeSales ? db.all(`SELECT * FROM (${top.sql}) items ORDER BY net_sales DESC, id LIMIT 10`, top.params) : [],
    ['combined', 'inventory'].includes(mode) ? db.all(`SELECT * FROM (${ingredients.sql}) ingredients ORDER BY inventory_consumed DESC, id LIMIT 10`, ingredients.params) : [],
    // Includes prepared cancellations that deliberately did not restore/deduct stock again.
    db.all(`${inventoryMasterCtes()} SELECT CAST(${nepalDateSql('w.created_at')} AS TEXT) AS id, SUM(CAST(w.total_cost AS NUMERIC)) AS wastage,
      SUM(CASE WHEN w.total_cost IS NULL THEN 1 ELSE 0 END) AS missing_cost
      FROM wastage_log w LEFT JOIN inventory_items ii ON ii.id=w.raw_material_id
      LEFT JOIN inventory_categories ic ON ic.id=ii.category_id
      LEFT JOIN inventory_masters im ON im.inventory_item_id=ii.id
      LEFT JOIN recipes r ON r.id=w.recipe_id LEFT JOIN menu_items mi ON mi.id=COALESCE(w.menu_item_id,r.menu_item_id)
      LEFT JOIN menu_categories mc ON mc.id=mi.category_id
      WHERE ${wasteWhere} AND COALESCE(w.status,'active') <> 'voided' ${wasteFilter}
      GROUP BY CAST(${nepalDateSql('w.created_at')} AS TEXT) ORDER BY id LIMIT 366`, wasteParams),
  ]);
  const byDay = new Map();
  for (const rows of [purchaseDays, saleDays, wastage]) for (const row of rows) byDay.set(row.id, { ...(byDay.get(row.id) || { id: row.id }), ...row });
  return { days: [...byDay.values()].sort((a, b) => a.id.localeCompare(b.id)), topItems, highConsumption,
    recordedWastage: Number(wastage.reduce((sum, row) => sum + paisa(row.wastage || 0), 0n)) / 100,
    unpricedWastageCount: wastage.reduce((sum, row) => sum + Number(row.missing_cost || 0), 0),
    wastageScope: 'Recorded wastage log, including prepared cancellations, scoped by date/business day and master category. Item/category/search/supplier filters do not apply to this chart.',
    dailyLimit: 366 };
}
