/** Small owner-facing column set shared by the screen and printed reports. */
export const ANALYSIS_DESCRIPTIONS = {
  combined: 'Purchase invoices and billed sales grouped by master category. Purchases add stock; gross profit uses the recorded ingredient cost of sales, not purchases in this period.',
  purchases: 'Received purchase invoice values allocated to inventory categories, including invoice discounts, tax and delivery costs.',
  sales: 'Billed sales less recorded ingredient costs. Historical costs require saved stock deductions linked to each sold item.',
  inventory: 'Stock deductions and restorations recorded in this period, including unbilled orders. These can differ from ingredient costs for billed sales. Stock value is the current balance.',
};

export function analysisValueIsPartial(row, key) {
  return key === 'stock_value' ? Number(row.unpriced_stock) > 0
    : ['stock_deducted', 'stock_restored', 'inventory_consumed', 'wastage'].includes(key) && Number(row.unpriced_movements) > 0;
}

export function simpleAnalysisColumns(mode, level = 'master') {
  const name = { key: 'name', label: level === 'item' ? 'Item' : 'Category', sort: 'name' };
  const bought = { key: 'net_purchases', label: 'Purchased', sort: 'purchased', money: true };
  const sold = { key: 'net_sales', label: 'Sold', sort: 'sales', money: true };
  const used = { key: 'consumption_cost', label: 'Used for sales', money: true };
  const profit = { key: 'gross_profit', label: 'Gross profit', money: true };
  const margin = { key: 'gross_margin', label: 'Margin', percent: true };
  if (mode === 'combined') return [name, bought, sold, used, profit, margin];
  const source = { key: 'mapping_source', label: 'Master category source' };
  if (mode === 'purchases') return [name,
    ...(level === 'item' ? [source] : []),
    ...(level === 'item' ? [{ key: 'purchased_quantity', label: 'Quantity' }, { key: 'unit', label: 'Unit' }] : []), bought,
    ...(level === 'item' ? [{ key: 'current_stock', label: 'Stock now' }, { key: 'stock_unit', label: 'Stock unit' }] : [{ key: 'supplier_count', label: 'Suppliers' }])];
  if (mode === 'sales') return [name, { key: 'quantity_sold', label: 'Qty sold', sort: 'quantity' }, sold, used, profit, margin];
  return [name,
    ...(level === 'item' ? [source] : []),
    ...(level === 'item' ? [{ key: 'current_stock', label: 'Stock now' }, { key: 'stock_unit', label: 'Unit' }] : []),
    { key: 'stock_deducted', label: 'Deducted', money: true },
    { key: 'stock_restored', label: 'Restored', money: true },
    { key: 'inventory_consumed', label: 'Net used', money: true },
    { key: 'stock_value', label: 'Stock value now', money: true },
    { key: 'wastage', label: 'Wasted', money: true }];
}

export function analysisSummaryColumns(mode) {
  const keys = mode === 'combined' ? ['net_purchases', 'net_sales', 'consumption_cost', 'gross_profit']
    : mode === 'purchases' ? ['net_purchases', 'purchase_discount', 'purchase_tax', 'purchase_shipping']
      : mode === 'sales' ? ['net_sales', 'consumption_cost', 'gross_profit', 'gross_margin']
        : ['inventory_consumed', 'stock_value', 'wastage'];
  const extra = [
    { key: 'purchase_discount', label: 'Purchase discount', money: true },
    { key: 'purchase_tax', label: 'Purchase tax', money: true },
    { key: 'purchase_shipping', label: 'Delivery costs', money: true },
  ];
  const definitions = [...simpleAnalysisColumns(mode), ...extra];
  return keys.map((key) => definitions.find((c) => c.key === key)).filter(Boolean);
}
