/** SQL aggregates; combined subcategories use explicit inventory/menu links. */
import { billScope } from '@/lib/reports.js';
import { liveItemSql } from '@/lib/report-scope.js';
import { FOOD_GROUPS, foodGroupSql } from '@/lib/food-groups.js';
import { inventoryMasterCtes } from '@/lib/inventory-master.js';
import { nepalOperationalRangeBounds, nepalDateSql, purchaseInvoiceDateSql } from '@/lib/report-dates.js';
import { paginateQuery, resolveOrderBy } from '@/lib/paginate.js';

const numeric = (sql) => `CAST(${sql} AS NUMERIC)`;
// Same allocation policy as Reports, with decimal operands before division.
const LINE_REVENUE = `${numeric('COALESCE(oi.subtotal, oi.quantity * COALESCE(oi.price, 0))')} *
  CASE WHEN COALESCE(b.subtotal,0) > 0 THEN
    CASE WHEN COALESCE(b.discount_amount,0) >= b.subtotal THEN 0
      ELSE (${numeric('b.subtotal')} - ${numeric('COALESCE(b.discount_amount,0)')}) / (${numeric('b.subtotal')} * 1.0) END ELSE 1 END`;
const invMaster = "COALESCE(im.master, 'uncategorised')";

/** Offer only masters used by the relevant current category / inventory setup. */
export async function analysisMasterGroups(db, mode) {
  const groups = new Set();
  if (['combined', 'sales'].includes(mode)) {
    const rows = await db.all(`SELECT DISTINCT ${foodGroupSql('mc')} AS master
      FROM menu_categories mc WHERE mc.is_active = 1`);
    for (const row of rows) groups.add(row.master);
  }
  if (['combined', 'purchases', 'inventory'].includes(mode)) {
    const rows = await db.all(`${inventoryMasterCtes()}
      SELECT DISTINCT im.master FROM inventory_masters im
      JOIN inventory_items ii ON ii.id = im.inventory_item_id WHERE COALESCE(ii.is_archived, 0) = 0`);
    for (const row of rows) groups.add(row.master);
  }
  return [...FOOD_GROUPS, { id: 'uncategorised', label: 'Uncategorised' }].filter((group) => groups.has(group.id));
}

export const ANALYSIS_METHOD = {
  categories: 'Inventory master assignments take precedence. Otherwise direct menu links, variant links and active recipes (including sub-recipes) determine each inventory item\'s master when linked menu categories agree. Shared items remain Uncategorised and flagged for assignment; purchase value is counted once. Category-name defaults apply only to unlinked inventory. Classification follows current links; historical sale costs remain recorded snapshots.',
  currency: 'NPR', purchases: 'Received/partial purchase headers, invoice date (Nepal entry date when absent) or assigned business day. Line value, discount, tax and shipping are allocated separately; invoice net is not inventory valuation.',
  sales: 'Counted bills, bill creation date or assigned business day. Revenue excludes tax/service charges; bill discounts are allocated pro rata. Refunds are allocated to the original bill, net of tax/service charges.',
  costs: 'Recorded moving-average stock deductions less explicit stock restorations, attributed to the original sale. Shortages, absent attribution and zero/unverified costs make gross profit unavailable. Current recipe costs never reprice historical sales.',
  accounting: 'Existing purchases-as-expense accounting is retained. Actual posted perpetual COGS is unavailable; no new journals are posted. Gross profit based on recorded consumption is an operational measure, not net operating profit.',
  stock: 'Stock and stock value are current, not period-end. Recorded consumption and wastage use movement date/business day. Purchase returns are unavailable: the existing workflow supports purchase voids, not supplier credit-note returns.',
};

export function purchaseAnalysisScope(range, filters = {}) {
  if (filters.businessDayId) return {
    sql: `EXISTS (SELECT 1 FROM expenses pe WHERE pe.source_type = 'purchase' AND pe.source_id = p.id AND pe.business_day_id = ?)`,
    params: [filters.businessDayId],
  };
  return { sql: `${purchaseInvoiceDateSql()} BETWEEN ? AND ?`, params: [range.start, range.end] };
}

function eventScope(alias, range, filters) {
  if (alias === 'p') return purchaseAnalysisScope(range, filters);
  if (filters.businessDayId) return { sql: `${alias}.business_day_id = ?`, params: [filters.businessDayId] };
  const { start, endExclusive } = nepalOperationalRangeBounds(filters.driver, range.start, range.end);
  return { sql: `${alias}.created_at >= ? AND ${alias}.created_at < ?`, params: [start, endExclusive] };
}

function dimensions(side, level) {
  const inventory = side === 'inventory';
  const master = inventory ? invMaster : foodGroupSql('mc');
  const category = inventory ? `COALESCE(ic.name, 'Uncategorised')` : `COALESCE(mc.name, 'Uncategorised')`;
  const categoryId = inventory ? 'COALESCE(ic.id, 0)' : 'COALESCE(mc.id, 0)';
  const id = level === 'master' ? master : level === 'category' ? `CAST(${categoryId} AS TEXT)` : inventory ? `CAST(COALESCE(ii.id, 0) AS TEXT)` : `CAST(COALESCE(s.menu_item_id, 0) AS TEXT)`;
  const name = level === 'master' ? master : level === 'category' ? category : inventory ? `COALESCE(ii.item_name, 'Archived / unmapped item')` : `COALESCE(mi.name, s.item_name, 'Archived / unmapped item')`;
  if (level === 'day') {
    const day = inventory ? purchaseInvoiceDateSql() : `CAST(${nepalDateSql('s.sold_created_at')} AS TEXT)`;
    return { master, category: "'All categories'", categoryId, id: day, name: day };
  }
  return { master, category, categoryId, id, name };
}

function selection(d, filters, params, itemExpr, nameExpr) {
  let sql = '';
  if (filters.master) { sql += ` AND ${d.master} = ?`; params.push(filters.master); }
  if (filters.categoryId != null) { sql += ` AND ${d.categoryId} = ?`; params.push(filters.categoryId); }
  if (filters.itemId) { sql += ` AND ${itemExpr} = ?`; params.push(filters.itemId); }
  if (filters.search) { sql += ` AND LOWER(${nameExpr}) LIKE ?`; params.push(`%${filters.search.toLowerCase()}%`); }
  return sql;
}

export function purchaseAnalysisQuery(db, range, filters, level, linkedCategories = false) {
  let d = dimensions('inventory', level);
  // A shared ingredient must not repeat its entire purchase value in each recipe category.
  // Only an unambiguous link can assign an invoice line to one menu subcategory.
  const categoryLinks = linkedCategories ? `, inventory_category_links AS (
    SELECT link.inventory_item_id, COUNT(DISTINCT linked_mc.id) AS category_count,
      MIN(linked_mc.id) AS category_id, MIN(linked_mc.name) AS category_name
    FROM inventory_menu_links link JOIN inventory_masters mapping ON mapping.inventory_item_id = link.inventory_item_id
      JOIN menu_items linked_mi ON linked_mi.id = link.menu_item_id
      JOIN menu_categories linked_mc ON linked_mc.id = linked_mi.category_id AND linked_mc.is_active = 1
    WHERE ${foodGroupSql('linked_mc')} = mapping.master
    GROUP BY link.inventory_item_id
  )` : '';
  if (linkedCategories) {
    const id = `CASE WHEN cl.category_count = 1 THEN CAST(cl.category_id AS TEXT)
      WHEN cl.category_count > 1 THEN 'shared-stock' ELSE 'unlinked-stock' END`;
    const name = `CASE WHEN cl.category_count = 1 THEN cl.category_name
      WHEN cl.category_count > 1 THEN 'Shared stock' ELSE 'Unlinked stock' END`;
    d = { ...d, id, name, category: name, categoryId: 'cl.category_id' };
  }
  const scope = eventScope('p', range, { ...filters, driver: db.driver });
  const params = [...scope.params];
  let where = `${scope.sql} AND p.status IN ('received', 'partial')`;
  if (filters.supplierId) { where += ' AND p.supplier_id = ?'; params.push(filters.supplierId); }
  where += selection(d, filters, params, 'ii.id', `COALESCE(ii.item_name, '')`);
  const share = `CASE WHEN p.subtotal > 0 THEN ${numeric('pi.line_total')} / (${numeric('p.subtotal')} * 1.0) ELSE 0 END`;
  const select = `${inventoryMasterCtes()}${categoryLinks} SELECT ${d.id} AS id, ${d.name} AS name,
    ${level === 'category' ? `CASE WHEN COUNT(DISTINCT ${d.master}) > 1 THEN 'mixed' ELSE MIN(${d.master}) END` : d.master} AS master,
    ${level === 'master' ? "'All inventory categories'" : d.category} AS category,
    COUNT(DISTINCT CASE WHEN im.mapping_conflicts = 1 THEN ii.id END) AS mapping_conflicts,
    ${level === 'item' ? 'MAX(im.mapping_source)' : 'NULL'} AS mapping_source,
    SUM(${numeric('pi.line_total')}) AS purchased,
    SUM(${numeric('p.discount')} * ${share}) AS purchase_discount,
    SUM(${numeric('p.tax')} * ${share}) AS purchase_tax,
    SUM(${numeric('p.shipping')} * ${share}) AS purchase_shipping,
    SUM(${numeric('pi.line_total')} + (${numeric('p.tax')} + ${numeric('p.shipping')} - ${numeric('p.discount')}) * ${share}) AS net_purchases,
    COUNT(DISTINCT p.supplier_id) AS supplier_count,
    ${level === 'item' ? `SUM(pi.quantity_received) AS purchased_quantity, MAX(COALESCE(ii.purchase_unit, ii.unit)) AS unit,
      MAX(ii.quantity) AS current_stock, MAX(COALESCE(ii.consumption_unit, ii.unit)) AS stock_unit,
      MAX(${numeric('ii.quantity')} * ${numeric('ii.cost_per_unit')}) AS stock_value,
      CASE WHEN SUM(pi.quantity_received) > 0 THEN SUM(${numeric('pi.line_total')}) / (SUM(pi.quantity_received) * 1.0) ELSE NULL END AS average_purchase_price` : "NULL AS purchased_quantity, NULL AS unit"}
    FROM purchases p JOIN purchase_items pi ON pi.purchase_id = p.id
    LEFT JOIN inventory_items ii ON ii.id = pi.inventory_item_id
    LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
    LEFT JOIN inventory_masters im ON im.inventory_item_id = ii.id
    ${linkedCategories ? 'LEFT JOIN inventory_category_links cl ON cl.inventory_item_id = ii.id' : ''} WHERE ${where}
    GROUP BY ${d.id}, ${d.name}${level === 'category' ? '' : `, ${d.master}`}${['master', 'day'].includes(level) ? '' : `, ${d.category}`}`;
  return { sql: select, params };
}

export function salesAnalysisQuery(db, range, filters, level) {
  const scope = billScope(db, range, { businessDayId: filters.businessDayId });
  const d = dimensions('sales', level);
  const params = [...scope.params];
  const filter = selection(d, filters, params, 's.menu_item_id', `COALESCE(mi.name, s.item_name, '')`);
  // First collapse bill lines, then join ONE cost aggregate per menu/order/variant.
  // Payments are intentionally never joined: split settlements cannot multiply sales.
  const sql = `WITH sold AS (
    SELECT o.id AS order_id, COALESCE(oi.menu_item_id, oi.item_id) AS menu_item_id,
      MIN(b.created_at) AS sold_created_at,
      COALESCE(oi.variant_name, '') AS variant_name, MAX(oi.item_name) AS item_name,
      SUM(oi.quantity) AS quantity,
      SUM(${numeric('COALESCE(oi.subtotal, oi.quantity * COALESCE(oi.price, 0))')}) AS gross_sales,
      SUM(${LINE_REVENUE}) AS discounted_sales,
      SUM((${LINE_REVENUE}) * CASE WHEN b.grand_total > 0 THEN ${numeric('COALESCE(b.refunded_amount, 0)')} / (${numeric('b.grand_total')} * 1.0) ELSE 0 END) AS refunds
    FROM bills b JOIN orders o ON o.id = b.order_id JOIN order_items oi ON oi.order_id = o.id
    ${scope.sql} AND ${liveItemSql('oi')}
    GROUP BY o.id, COALESCE(oi.menu_item_id, oi.item_id), COALESCE(oi.variant_name, '')
  ), quantities AS (
    SELECT reference_id, sale_menu_item_id, variant_name, SUM(qty) AS attributed_quantity FROM (
      SELECT m.reference_id, m.sale_menu_item_id, COALESCE(m.sale_variant, '') AS variant_name,
        m.consumption_key, MAX(m.sold_quantity) AS qty
      FROM stock_movements m WHERE m.consumption_key IS NOT NULL
        AND m.change_type IN ('order_deduction', 'order_void')
        AND EXISTS (SELECT 1 FROM sold s WHERE CAST(s.order_id AS TEXT) = m.reference_id AND s.menu_item_id = m.sale_menu_item_id)
      GROUP BY m.reference_id, m.sale_menu_item_id, COALESCE(m.sale_variant, ''), m.consumption_key
    ) events GROUP BY reference_id, sale_menu_item_id, variant_name
  ), costs AS (
    SELECT m.reference_id, m.sale_menu_item_id, COALESCE(m.sale_variant, '') AS variant_name,
      SUM(-${numeric('m.quantity_changed')} * ${numeric('m.unit_cost')}) AS consumption_cost,
      SUM(CASE WHEN m.cost_status <> 'Cost Available' OR m.cost_status IS NULL OR m.unit_cost IS NULL THEN 1 ELSE 0 END) AS missing_cost
    FROM stock_movements m WHERE m.change_type IN ('order_deduction', 'order_void') AND m.consumption_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM sold s WHERE CAST(s.order_id AS TEXT) = m.reference_id AND s.menu_item_id = m.sale_menu_item_id)
    GROUP BY m.reference_id, m.sale_menu_item_id, COALESCE(m.sale_variant, '')
  )
  SELECT ${d.id} AS id, ${d.name} AS name, ${d.master} AS master,
    ${level === 'master' ? "'All menu categories'" : d.category} AS category,
    SUM(s.quantity) AS quantity_sold, SUM(s.gross_sales) AS gross_sales,
    SUM(s.gross_sales - s.discounted_sales) AS discounts, SUM(s.refunds) AS refunds,
    SUM(s.discounted_sales - s.refunds) AS net_sales,
    SUM(COALESCE(c.consumption_cost, 0)) AS recorded_cost,
    SUM(CASE WHEN c.reference_id IS NULL OR ABS(COALESCE(q.attributed_quantity, 0) - s.quantity) > 0.000001 THEN 1 ELSE 0 END) AS missing_mapping,
    SUM(CASE WHEN COALESCE(c.missing_cost, 0) > 0 THEN 1 ELSE 0 END) AS missing_cost,
    CASE WHEN SUM(CASE WHEN c.reference_id IS NULL OR c.missing_cost > 0 OR ABS(COALESCE(q.attributed_quantity, 0) - s.quantity) > 0.000001 THEN 1 ELSE 0 END) > 0 THEN NULL
      ELSE SUM(c.consumption_cost) END AS consumption_cost
  FROM sold s LEFT JOIN menu_items mi ON mi.id = s.menu_item_id
  LEFT JOIN menu_categories mc ON mc.id = mi.category_id
  LEFT JOIN costs c ON c.reference_id = CAST(s.order_id AS TEXT) AND c.sale_menu_item_id = s.menu_item_id AND c.variant_name = s.variant_name
  LEFT JOIN quantities q ON q.reference_id = CAST(s.order_id AS TEXT) AND q.sale_menu_item_id = s.menu_item_id AND q.variant_name = s.variant_name
  WHERE 1=1 ${filter} GROUP BY ${d.id}, ${d.name}, ${d.master}${['master', 'day'].includes(level) ? '' : `, ${d.category}`}`;
  return { sql, params };
}

export function inventoryAnalysisQuery(db, range, filters, level) {
  const d = dimensions('inventory', level);
  const scope = eventScope('m', range, { ...filters, driver: db.driver });
  const params = [...scope.params];
  const filter = selection(d, filters, params, 'ii.id', `COALESCE(ii.item_name, '')`);
  return { sql: `${inventoryMasterCtes()}, moves AS (
    SELECT m.inventory_item_id,
      SUM(CASE WHEN m.change_type = 'order_deduction' THEN -${numeric('m.quantity_changed')} * ${numeric('m.unit_cost')} ELSE 0 END) AS stock_deducted,
      SUM(CASE WHEN m.change_type = 'order_void' THEN ${numeric('m.quantity_changed')} * ${numeric('m.unit_cost')} ELSE 0 END) AS stock_restored,
      SUM(CASE WHEN m.change_type IN ('order_deduction', 'order_void') THEN -${numeric('m.quantity_changed')} * ${numeric('m.unit_cost')} ELSE 0 END) AS inventory_consumed,
      SUM(CASE WHEN m.change_type = 'wastage' THEN -${numeric('m.quantity_changed')} * ${numeric('m.unit_cost')} ELSE 0 END) AS wastage,
      SUM(CASE WHEN m.change_type IN ('order_deduction', 'order_void', 'wastage') AND
        (m.unit_cost IS NULL OR m.unit_cost <= 0 OR (m.cost_status IS NOT NULL AND m.cost_status <> 'Cost Available')) THEN 1 ELSE 0 END) AS unpriced_movements
    FROM stock_movements m WHERE ${scope.sql} GROUP BY m.inventory_item_id
  ) SELECT ${d.id} AS id, ${d.name} AS name,
    ${level === 'category' ? `CASE WHEN COUNT(DISTINCT ${d.master}) > 1 THEN 'mixed' ELSE MIN(${d.master}) END` : d.master} AS master,
    ${level === 'master' ? "'All inventory categories'" : d.category} AS category,
    SUM(COALESCE(im.mapping_conflicts, 0)) AS mapping_conflicts,
    ${level === 'item' ? 'MAX(im.mapping_source)' : 'NULL'} AS mapping_source,
    SUM(${numeric('ii.quantity')} * ${numeric('ii.cost_per_unit')}) AS stock_value,
    SUM(CASE WHEN ii.quantity <> 0 AND (ii.cost_per_unit IS NULL OR ii.cost_per_unit <= 0) THEN 1 ELSE 0 END) AS unpriced_stock,
    SUM(COALESCE(mv.inventory_consumed, 0)) AS inventory_consumed,
    SUM(COALESCE(mv.stock_deducted, 0)) AS stock_deducted,
    SUM(COALESCE(mv.stock_restored, 0)) AS stock_restored,
    SUM(COALESCE(mv.wastage, 0)) AS wastage,
    SUM(COALESCE(mv.unpriced_movements, 0)) AS unpriced_movements,
    ${level === 'item' ? "MAX(ii.quantity) AS current_stock, MAX(COALESCE(ii.consumption_unit, ii.unit)) AS stock_unit" : "NULL AS current_stock, NULL AS stock_unit"}
    FROM inventory_items ii LEFT JOIN inventory_categories ic ON ic.id = ii.category_id
    LEFT JOIN inventory_masters im ON im.inventory_item_id = ii.id
    LEFT JOIN moves mv ON mv.inventory_item_id = ii.id WHERE 1=1 ${filter}
    GROUP BY ${d.id}, ${d.name}${level === 'category' ? '' : `, ${d.master}`}${level === 'master' ? '' : `, ${d.category}`}`, params };
}

// Currency subtraction uses integer paisa, keeping binary floating-point out of profit arithmetic.
export function paisa(value) {
  const str = typeof value === 'number' && Math.abs(value) < 1e21 ? value.toFixed(8) : String(value ?? 0);
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error('Invalid monetary value.');
  const negative = str.startsWith('-');
  const [whole, fraction = ''] = str.replace('-', '').split('.');
  let result = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (Number(fraction[2] || 0) >= 5) result += 1n;
  return negative ? -result : result;
}
const amount = (value) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
function roundedRatio(numerator, denominator) {
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  return sign * ((n * 2n + d) / (d * 2n));
}

export function profitability(row) {
  const missing = Number(row.missing_mapping || 0) + Number(row.missing_cost || 0);
  const available = row.consumption_cost != null && !missing;
  const revenue = paisa(row.net_sales || 0);
  const profit = available ? revenue - paisa(row.consumption_cost) : null;
  return { ...row, actual_posted_cogs: null,
    gross_profit: profit == null ? null : amount(profit),
    gross_margin: profit == null || revenue === 0n ? null : Number(roundedRatio(profit * 10000n, revenue)) / 100,
    cost_status: Number(row.missing_mapping) > 0 ? 'Missing Recipe / Mapping' : !available ? 'Missing Cost' : 'Cost Available' };
}

export async function analysisRows(db, query, list) {
  const allowed = { name: 'name' };
  for (const [key, column] of Object.entries({ purchased: 'net_purchases', sales: 'net_sales', quantity: 'quantity_sold' })) {
    if (query.sql.includes(`AS ${column}`)) allowed[key] = column;
  }
  const orderBy = resolveOrderBy(list.sort, list.dir, allowed, 'name', 'id');
  const result = await paginateQuery(db, { columns: '*', from: `(${query.sql}) analysis`, params: query.params,
    orderBy, page: list.page, pageSize: list.pageSize, exportAll: list.exportAll });
  return result;
}

export async function buildPurchaseSalesAnalysis(db, range, filters, list, mode = 'combined', level = 'master') {
  if (mode === 'combined') level = level === 'category' && filters.master ? 'category' : 'master';
  const queries = {
    purchases: purchaseAnalysisQuery(db, range, filters, level, mode === 'combined' && level === 'category'),
    sales: salesAnalysisQuery(db, range, filters, level),
    inventory: inventoryAnalysisQuery(db, range, filters, level),
  };
  if (mode !== 'combined') {
    const query = queries[mode];
    // Filtered aggregate has one row per group, not one row per transaction.
    const columns = mode === 'sales' ? ['gross_sales', 'discounts', 'refunds', 'net_sales', 'recorded_cost', 'missing_mapping', 'missing_cost'] : mode === 'purchases' ? ['purchased', 'purchase_discount', 'purchase_tax', 'purchase_shipping', 'net_purchases', 'mapping_conflicts'] : ['stock_value', 'inventory_consumed', 'stock_deducted', 'stock_restored', 'wastage', 'unpriced_stock', 'unpriced_movements', 'mapping_conflicts'];
    const [result, totals] = await Promise.all([
      analysisRows(db, query, list),
      db.get(`SELECT ${columns.map((c) => `SUM(${c}) AS ${c}`).join(',')}${mode === 'sales' ? ', CASE WHEN SUM(missing_mapping + missing_cost) > 0 THEN NULL ELSE SUM(consumption_cost) END AS consumption_cost' : ''} FROM (${query.sql}) totals`, query.params),
    ]);
    return { ...result, rows: mode === 'sales' ? result.rows.map(profitability) : result.rows,
      totals: mode === 'sales' ? profitability(totals || {}) : totals, mode, level, methodology: ANALYSIS_METHOD };
  }
  const [purchases, sales, inventory] = await Promise.all(Object.entries(queries).map(([key, q]) =>
    key === 'inventory' && level === 'category' ? [] : db.all(q.sql, q.params)));
  const rows = new Map();
  for (const set of [purchases, inventory, sales]) for (const row of set) {
    rows.set(row.id, { ...(rows.get(row.id) || { id: row.id, name: row.name, master: row.master,
      net_sales: '0', consumption_cost: '0', net_purchases: '0', inventory_consumed: '0', stock_value: '0', wastage: '0', unpriced_stock: 0, unpriced_movements: 0 }), ...row });
  }
  const result = [...rows.values()].map(profitability);
  const sortKey = { purchased: 'net_purchases', sales: 'net_sales', quantity: 'quantity_sold' }[list.sort];
  const sign = String(list.dir).toLowerCase() === 'desc' ? -1 : 1;
  result.sort((a, b) => sign * (sortKey ? Number(a[sortKey] || 0) - Number(b[sortKey] || 0) : a.name.localeCompare(b.name)) || String(a.id).localeCompare(String(b.id)));
  const fields = ['net_purchases', 'net_sales', 'inventory_consumed', 'stock_value', 'wastage', 'consumption_cost'];
  const totals = Object.fromEntries(fields.map((field) => [field, amount(result.reduce((sum, row) => sum + paisa(row[field] || 0), 0n))]));
  totals.missing_mapping = result.reduce((sum, row) => sum + Number(row.missing_mapping || 0), 0);
  totals.missing_cost = result.reduce((sum, row) => sum + Number(row.missing_cost || 0), 0);
  totals.unpriced_stock = result.reduce((sum, row) => sum + Number(row.unpriced_stock || 0), 0);
  totals.unpriced_movements = result.reduce((sum, row) => sum + Number(row.unpriced_movements || 0), 0);
  totals.mapping_conflicts = result.reduce((sum, row) => sum + Number(row.mapping_conflicts || 0), 0);
  if (totals.missing_mapping || totals.missing_cost) totals.consumption_cost = null;
  return { rows: result, totals: profitability(totals), mode, level, methodology: ANALYSIS_METHOD };
}
