import { simpleAnalysisColumns, analysisSummaryColumns, analysisValueIsPartial } from '@/lib/analysis-presentation.js';
import { foodGroupLabel } from '@/lib/food-groups.js';
import { receiptStyle, formatReceiptMoney } from '@/lib/print-receipt.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const names = { combined: 'Purchase & Sales Report', purchases: 'Purchase Report', sales: 'Sales & Cost Report', inventory: 'Stock & Usage Report' };

export function printableAnalysisValue(column, value) {
  if (value == null || value === '') return '—';
  if (column.money) return formatReceiptMoney(value, { prefix: true });
  if (column.percent || column.key === 'gross_margin') return `${Number(value).toFixed(2)}%`;
  return String(value);
}

/** Report-only HTML. Never captures the application DOM, navigation or charts. */
export function buildAnalysisPrintHtml(report, { size = '80', restaurantName = '', scope = '' } = {}) {
  const columns = simpleAnalysisColumns(report.mode, report.level).filter((column) => column.key !== 'name');
  const row = (label, value, total = false) => `<div class="report-line${total ? ' report-total' : ''}"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`;
  const value = (column, item) => printableAnalysisValue(column, item?.[column.key]) + (analysisValueIsPartial(item || {}, column.key) ? ' (partial)' : '');
  const summary = analysisSummaryColumns(report.mode).map((column) => row(column.label, value(column, report.totals), true)).join('');
  const margin = report.mode === 'combined' && report.totals?.gross_margin != null ? row('Margin', printableAnalysisValue({ percent: true }, report.totals.gross_margin), true) : '';
  const demo = report.businessDays?.some((day) => Number(day.id) === Number(report.filters?.businessDayId) && day.opening_note?.includes('[DEMO]'));
  const items = report.rows.map((item) => {
    const title = report.level === 'master' ? foodGroupLabel(item.name) : item.name;
    const values = columns.filter((column) => item[column.key] != null || column.money || column.percent)
      .map((column) => row(column.label, value(column, item))).join('');
    return `<section class="report-item"><h2>${escape(title)}</h2>${values}</section>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escape(names[report.mode])}</title>
    ${receiptStyle(size, { layout: 'bill' })}
    <style>
      body{font-size:14px;line-height:1.45;padding:3mm 1mm;color:#000;background:#fff}
      h1{font-size:17px;line-height:1.25;margin:1mm 0 2mm;font-weight:800}
      h2{font-size:15px;line-height:1.3;margin:0 0 1.5mm;font-weight:800;overflow-wrap:anywhere}
      .report-head{text-align:center;border-bottom:2px solid #000;padding-bottom:3mm;margin-bottom:3mm}
      .report-head p{font-size:12px;margin:1mm 0;overflow-wrap:anywhere}
      .report-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2mm;align-items:baseline;margin:1.2mm 0}
      .report-line span{overflow-wrap:anywhere}.report-line strong{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
      .report-total{font-size:14px;font-weight:700}.report-summary{border-bottom:2px solid #000;padding-bottom:3mm}
      .report-item{padding:3mm 0;border-bottom:1px dashed #000;break-inside:avoid;page-break-inside:avoid}
      .report-note{font-size:12px;margin:2mm 0;line-height:1.4}.report-foot{margin-top:3mm;border-top:1px solid #000;padding-top:2mm}
      @media print{html,body{background:#fff;color:#000}body{margin:0 auto}a{color:#000;text-decoration:none}}
    </style></head><body><header class="report-head">${restaurantName ? `<p>${escape(restaurantName)}</p>` : ''}
      <h1>${escape(names[report.mode])}</h1>${demo ? '<p><strong>DEMO - SAMPLE DATA</strong></p>' : ''}<p>${escape(report.range?.label || `${report.range?.start || ''} - ${report.range?.end || ''}`)}</p>
      ${scope ? `<p>${escape(scope)}</p>` : ''}<p>Amounts in NPR</p>
    </header><section class="report-summary"><h2>Total</h2>${summary}${margin}</section>
    ${items || '<p class="report-note">No transactions match this selection.</p>'}
    <footer class="report-foot">
      <p class="report-note">${report.rows.length} ${report.level === 'item' ? 'items' : 'categories'} · End of report</p></footer></body></html>`;
}

export function printAnalysisHtml(html) {
  const frame = document.createElement('iframe');
  frame.title = 'Report only — print document';
  frame.dataset.analysisPrint = 'true';
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:310px;height:1000px;border:0';
  frame.srcdoc = html;
  frame.addEventListener('load', async () => {
    await frame.contentDocument.fonts?.ready;
    frame.contentWindow.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, { once: true });
  document.body.appendChild(frame);
  setTimeout(() => frame.remove(), 120000);
  return frame;
}
