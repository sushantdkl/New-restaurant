import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisPrintHtml, printableAnalysisValue } from '@/lib/analysis-print.js';
import { simpleAnalysisColumns } from '@/lib/analysis-presentation.js';

const report = {
  mode: 'combined', level: 'master', range: { label: '25 October 2026' }, basis: 'Business day #60',
  totals: { net_purchases: '1860', net_sales: '14440', consumption_cost: '5204.30', gross_profit: '9235.70', gross_margin: 63.96 },
  rows: [{ name: 'food', net_purchases: '1860', net_sales: '9120', consumption_cost: '2294.30', gross_profit: '6825.70', gross_margin: 74.84 }],
};

test('80mm report uses readable label/value blocks and contains only report data', () => {
  const html = buildAnalysisPrintHtml(report, { size: '80', restaurantName: 'Demo Restaurant', scope: 'Food / All items' });
  assert.match(html, /size: 80mm auto/); assert.match(html, /width: 72mm/);
  assert.match(html, /font-size:14px/); assert.match(html, /Rs\. 14,440\.00/); assert.match(html, /Rs\. 9,235\.70/);
  assert.match(html, /25 October 2026/); assert.match(html, /Food \/ All items/);
  assert.doesNotMatch(html, /Business day #60/);
  assert.match(html, /End of report/);
  assert.doesNotMatch(html, /<table|<nav|<aside|<svg|<script|Admin Panel|Show charts|More columns/);
});

test('missing costs stay unavailable on paper; report fields are escaped', () => {
  const html = buildAnalysisPrintHtml({ ...report, totals: { ...report.totals, gross_profit: null, missing_cost: 1 },
    rows: [{ name: 'food', net_sales: 100, consumption_cost: null, gross_profit: null, cost_status: 'Missing Cost' }] },
  { restaurantName: '<script>unsafe</script>', scope: '<img onerror="unsafe">' });
  assert.match(html, /<strong>—<\/strong>/);
  assert.doesNotMatch(html, /Not available|Profit is not available/);
  assert.doesNotMatch(html, /Some saved ingredient deductions/);
  assert.equal(printableAnalysisValue({ money: true }, null), '—');
  assert.equal(printableAnalysisValue({ percent: true }, null), '—');
  assert.match(printableAnalysisValue({ money: true }, 0), /0\.00/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<img /);
});

test('A4 print is still report-only; the default screen has six simple comparison columns', () => {
  assert.match(buildAnalysisPrintHtml(report, { size: 'a4' }), /size: A4/);
  assert.deepEqual(simpleAnalysisColumns('combined').map((column) => column.label), ['Category', 'Purchased', 'Sold', 'Used for sales', 'Gross profit', 'Margin']);
  assert.equal(simpleAnalysisColumns('sales').some((column) => column.key === 'actual_posted_cogs'), false);
  const demo = buildAnalysisPrintHtml({ ...report, filters: { businessDayId: 60 }, businessDays: [{ id: 60, opening_note: '[DEMO] Sample day' }] });
  assert.match(demo, /DEMO - SAMPLE DATA/);
});

test('inventory print separates restored stock and marks incomplete zero values', () => {
  const html = buildAnalysisPrintHtml({ ...report, mode: 'inventory', level: 'category',
    rows: [{ name: 'Meat/Fish', stock_deducted: 0, stock_restored: 2000, inventory_consumed: -2000, stock_value: 0, unpriced_stock: 1, unpriced_movements: 1 }],
    totals: { inventory_consumed: -2000, stock_value: 0, unpriced_stock: 1, unpriced_movements: 1 } });
  assert.match(html, /Deducted/);
  assert.match(html, /Restored/);
  assert.match(html, /Net used/);
  assert.match(html, /0\.00 \(partial\)/);
  assert.doesNotMatch(html, /negative value means more stock was restored/);
});

test('80mm and A4 omit explanatory blocks while retaining dates, scope and missing-value dashes', () => {
  for (const size of ['80', 'a4']) {
    const html = buildAnalysisPrintHtml({ ...report, basis: 'Recorded transaction date (Nepal)',
      totals: { ...report.totals, missing_mapping: 1, missing_cost: 1, mapping_conflicts: 1, gross_profit: null } },
    { size, scope: 'Beverages' });
    assert.doesNotMatch(html, /Recorded transaction date|Inventory masters use|Some sold items|Some saved ingredient|Review inventory master|Adding a recipe|Gross profit excludes/);
    assert.match(html, /25 October 2026/);
    assert.match(html, /Beverages/);
    assert.match(html, /<strong>—<\/strong>/);
  }
});
