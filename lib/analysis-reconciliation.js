import { columnExists } from '@/lib/db/schema-helpers.js';
import { paisa, purchaseAnalysisScope } from '@/lib/purchase-sales-analysis.js';

/** Read-only source checks. Never repairs records or posts accounting entries. */
export async function analysisReconciliation(db, range, filters) {
  const scope = purchaseAnalysisScope(range, filters);
  const params = [...scope.params];
  let where = scope.sql;
  if (filters.supplierId) { where += ' AND p.supplier_id=?'; params.push(filters.supplierId); }
  const row = await db.get(`SELECT SUM(CAST(p.total AS NUMERIC)) AS invoice_total,
    SUM(COALESCE(e.amount,0)) AS linked_expense_total,
    SUM(CASE WHEN e.source_id IS NULL THEN 1 ELSE 0 END) AS missing_expenses,
    SUM(CASE WHEN e.expense_count > 1 THEN 1 ELSE 0 END) AS duplicate_expenses
    FROM purchases p LEFT JOIN (
      SELECT source_id, SUM(CAST(amount AS NUMERIC)) AS amount, COUNT(*) AS expense_count
      FROM expenses WHERE source_type='purchase' AND COALESCE(status,'active') <> 'voided' GROUP BY source_id
    ) e ON e.source_id=p.id WHERE p.status IN ('received','partial') AND ${where}`, params);
  const hasJournals = await columnExists(db, 'journal_entries', 'source_type');
  let journalChecks = null;
  if (hasJournals) {
    journalChecks = await db.get(`SELECT COUNT(*) AS linked_purchase_expenses,
      SUM(CASE WHEN j.id IS NULL THEN 1 ELSE 0 END) AS missing_journals,
      SUM(CASE WHEN j.id IS NOT NULL AND ABS(COALESCE(l.debits,0)-COALESCE(l.credits,0)) > 0.005 THEN 1 ELSE 0 END) AS unbalanced_journals
      FROM purchases p JOIN expenses e ON e.source_type='purchase' AND e.source_id=p.id AND COALESCE(e.status,'active') <> 'voided'
      LEFT JOIN journal_entries j ON j.source_type='expense' AND j.source_id=e.id
      LEFT JOIN (SELECT journal_id, SUM(debit) AS debits, SUM(credit) AS credits FROM journal_lines GROUP BY journal_id) l ON l.journal_id=j.id
      WHERE p.status IN ('received','partial') AND ${where}`, params);
  }
  return { ...row, journalChecks, invoice_expense_difference: Number(paisa(row?.invoice_total || 0) - paisa(row?.linked_expense_total || 0)) / 100,
    scope: 'Whole purchase invoices in the date/business-day and supplier scope. Category, item and search filters do not apply to this source check.',
    accounting_policy: 'Purchases as expense. Consumption is not posted perpetual COGS. Balanced source journals are a diagnostic, not a complete General Ledger reconciliation.' };
}
