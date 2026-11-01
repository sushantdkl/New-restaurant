import { toCsv } from '@/lib/csv.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function analysisExport(report, format, context) {
  const columns = [...new Set(report.rows.flatMap(Object.keys))];
  const metadata = { name: `NPR | ${context.range.label} | ${report.mode} / ${report.level} | ${context.basis}` };
  const rows = [metadata, ...Object.values(report.methodology).map((value) => ({ name: value })), ...report.rows, { name: 'TOTAL', ...report.totals }];
  if (format === 'csv') return { type: 'text/csv; charset=utf-8', extension: 'csv', body: toCsv(columns, rows) };
  // Excel's documented XML spreadsheet format; string cells cannot execute formulas.
  const xmlRow = (row) => `<Row>${columns.map((key) => `<Cell><Data ss:Type="String">${escape(row[key])}</Data></Cell>`).join('')}</Row>`;
  return { type: 'application/vnd.ms-excel; charset=utf-8', extension: 'xls', body:
    `<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Analysis"><Table>${xmlRow(Object.fromEntries(columns.map((c) => [c, c])))}${rows.map(xmlRow).join('')}</Table></Worksheet></Workbook>` };
}
