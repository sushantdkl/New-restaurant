import { beginPayrollRequest, finishPayrollRequest } from '@/lib/payroll-requests.js';
import { payrollMethod, payrollDate, payrollBusinessDay, payrollPayoutLines } from '@/lib/payroll-payout.js';
import { ensureMonthlyPayrollSchema, payrollMonth, salaryValue } from '@/lib/payroll-months.js';
/**
 * Payroll + employee performance, both built on data the POS already keeps.
 *
 * Payroll: users.salary / hire_date / position + a salary_payments ledger.
 * Performance: no separate attendance table exists, so metrics are derived from
 * real activity — orders taken and their value (waiter_id on orders), bills
 * settled and revenue (cashier_id on bills), and wastage logged (employee_id on
 * wastage_log). "Attendance" is not tracked by the system, so it is reported as
 * activity (days with orders) rather than invented.
 */

import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';
import { ensureColumn, serialPkSql } from '@/lib/db/schema-helpers.js';
import { ensureAccountingSchema, postJournal, deleteJournalBySource } from '@/lib/accounting.js';
import { currentBusinessDayId } from '@/lib/business-days.js';
import { nepalDateString } from '@/lib/report-dates.js';

export async function ensurePayrollSchema(db) {
  const pk = serialPkSql(db);
  await ensureColumn(db, 'users', 'salary', 'DOUBLE PRECISION');
  await ensureColumn(db, 'users', 'hire_date', 'DATE');
  await ensureColumn(db, 'users', 'position', 'TEXT');
  await ensureSqliteTable(
    db,
    `
    CREATE TABLE IF NOT EXISTS salary_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      period_label TEXT,
      paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
      method TEXT DEFAULT 'cash',
      note TEXT,
      paid_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `
  );
  await ensureColumn(db, 'salary_payments', 'business_day_id', 'INTEGER');
  await ensureColumn(db, 'salary_payments', 'gross_amount', 'DOUBLE PRECISION');
  await ensureColumn(db, 'salary_payments', 'advance_deduction', 'DOUBLE PRECISION DEFAULT 0');
  await ensureSqliteTable(
    db,
    `CREATE TABLE IF NOT EXISTS salary_advances (
      ${pk}, employee_id INTEGER NOT NULL, amount REAL NOT NULL,
      advanced_on DATE NOT NULL DEFAULT CURRENT_DATE, method TEXT DEFAULT 'cash',
      note TEXT, given_by INTEGER, business_day_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
  );
  await ensureMonthlyPayrollSchema(db);
}

const positiveMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

export async function listPayrollOverview(db) {
  return db.all(`
    SELECT u.id, u.full_name, u.username, u.role, u.position, u.salary, u.absence_daily_rate, u.is_active,
      COALESCE((SELECT SUM(a.amount) FROM salary_advances a WHERE a.employee_id = u.id), 0) AS total_advanced,
      COALESCE((SELECT SUM(p.advance_deduction) FROM salary_payments p WHERE p.employee_id = u.id), 0) AS total_deducted,
      COALESCE((SELECT SUM(a.amount) FROM salary_advances a WHERE a.employee_id = u.id), 0)
        - COALESCE((SELECT SUM(p.advance_deduction) FROM salary_payments p WHERE p.employee_id = u.id), 0)
        - COALESCE((SELECT SUM(w.amount) FROM staff_salary_adjustments w WHERE w.employee_id = u.id AND w.kind = 'advance_waiver'), 0) AS advance_outstanding,
      COALESCE((SELECT SUM(COALESCE(p.gross_amount, p.amount)) FROM salary_payments p WHERE p.employee_id = u.id), 0) AS total_salary_recorded,
      (SELECT MAX(p.paid_on) FROM salary_payments p WHERE p.employee_id = u.id) AS last_paid_on
    FROM users u
    ORDER BY CASE WHEN COALESCE(u.is_active, 0) = 1 THEN 0 ELSE 1 END, u.full_name, u.username
  `);
}

export async function advanceOutstanding(db, employeeId) {
  const row = await db.get(`
    SELECT
      COALESCE((SELECT SUM(amount) FROM salary_advances WHERE employee_id = ?), 0)
      - COALESCE((SELECT SUM(advance_deduction) FROM salary_payments WHERE employee_id = ?), 0)
      - COALESCE((SELECT SUM(amount) FROM staff_salary_adjustments WHERE employee_id = ? AND kind = 'advance_waiver'), 0) AS amount
  `, [employeeId, employeeId, employeeId]);
  return Math.max(0, positiveMoney(row?.amount));
}

export async function listAdvances(db, employeeId = null) {
  const where = employeeId ? 'WHERE a.employee_id = ?' : '';
  return db.all(
    `SELECT a.*, u.full_name AS employee_name, u.username AS employee_username,
            giver.full_name AS given_by_name,
            COALESCE((SELECT SUM(l.credit-l.debit) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_id JOIN accounts ac ON ac.id=l.account_id WHERE j.source_type='salary_advance' AND j.source_id=a.id AND ac.code='1050'),0) AS funding_amount
     FROM salary_advances a
     LEFT JOIN users u ON a.employee_id = u.id
     LEFT JOIN users giver ON a.given_by = giver.id
     ${where}
     ORDER BY a.advanced_on DESC, a.id DESC`,
    employeeId ? [employeeId] : []
  );
}

export async function recordAdvance(db, data, givenBy = null) {
  const employeeId = Number(data.employee_id);
  const amount = salaryValue(data.amount, 'Amount') ?? 0;
  const method = payrollMethod(data.method);
  const date = payrollDate(data.advanced_on || undefined);
  if (!employeeId) throw Object.assign(new Error('Choose the employee receiving the advance.'), { status: 400 });
  if (!(amount > 0)) throw Object.assign(new Error('Advance amount must be greater than zero.'), { status: 400 });

  const employee = await db.get('SELECT id, full_name, username FROM users WHERE id = ?', [employeeId]);
  if (!employee) throw Object.assign(new Error('Employee not found.'), { status: 404 });

  await ensureAccountingSchema(db);
  return db.transaction(async (tx) => {
    const request = await beginPayrollRequest(tx, data.request_key, 'salary_advances', [employeeId, amount, date, method, data.note || null], givenBy);
    if (request.replay) return request.replay;
    const businessDayId = await payrollBusinessDay(tx, date);
    if (db.driver === 'postgres') await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [employeeId]);
    const result = await tx.run(
      `INSERT INTO salary_advances (employee_id, amount, advanced_on, method, note, given_by, business_day_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [employeeId, amount, date, method, data.note || null, givenBy, businessDayId]
    );
    const advance = await tx.get(
      'SELECT * FROM salary_advances WHERE id = ?',
      [result.lastInsertRowid]
    );
    const payoutLines = await payrollPayoutLines(tx, { amount, method, date, businessDayId, useBusinessFunding: data.use_business_funding });
    await postJournal(tx, {
      entry_date: date,
      memo: `Salary advance — ${employee.full_name || employee.username}`,
      source_type: 'salary_advance',
      source_id: advance.id,
      created_by: givenBy,
      business_day_id: businessDayId,
      lines: [
        { code: '1310', debit: amount, credit: 0, memo: 'employee advance' },
        ...payoutLines,
      ],
    });
    await finishPayrollRequest(tx, request, 'salary_advances', advance.id);
    return advance;
  });
}

export async function deleteAdvance(db, id) {
  const businessDayId = await currentBusinessDayId(db, { required: true });
  const advance = await db.get('SELECT * FROM salary_advances WHERE id = ?', [id]);
  if (!advance) throw Object.assign(new Error('Salary advance not found.'), { status: 404 });
  if (Number(advance.business_day_id || 0) !== Number(businessDayId)) {
    throw Object.assign(new Error('An advance from a closed business day cannot be deleted.'), { status: 409 });
  }
  await db.transaction(async (tx) => {
    if (db.driver === 'postgres') await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [advance.employee_id]);
    if (await advanceOutstanding(tx, advance.employee_id) < Number(advance.amount)) {
      throw Object.assign(new Error('This advance has already been settled or waived and cannot be deleted.'), { status: 409 });
    }
    await deleteJournalBySource(tx, 'salary_advance', id);
    await tx.run(`DELETE FROM salary_advances WHERE id = ?`, [id]);
  });
}

export async function listPayments(db, employeeId = null) {
  if (employeeId) {
    return db.all(
      `SELECT p.*, u.full_name AS employee_name,
              COALESCE((SELECT SUM(l.credit-l.debit) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_id JOIN accounts ac ON ac.id=l.account_id WHERE j.source_type='payroll' AND j.source_id=p.id AND ac.code='1050'),0) AS funding_amount
       FROM salary_payments p LEFT JOIN users u ON p.employee_id = u.id
       WHERE p.employee_id = ? ORDER BY p.paid_on DESC, p.id DESC`,
      [employeeId]
    );
  }
  return db.all(
    `SELECT p.*, u.full_name AS employee_name,
              COALESCE((SELECT SUM(l.credit-l.debit) FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_id JOIN accounts ac ON ac.id=l.account_id WHERE j.source_type='payroll' AND j.source_id=p.id AND ac.code='1050'),0) AS funding_amount
     FROM salary_payments p LEFT JOIN users u ON p.employee_id = u.id
     ORDER BY p.paid_on DESC, p.id DESC`
  );
}

export async function recordPayment(db, data, paidBy = null) {
  const amount = salaryValue(data.amount, 'Amount') ?? 0;
  const method = payrollMethod(data.method);
  const date = payrollDate(data.paid_on || undefined);
  const advanceDeduction = salaryValue(data.advance_deduction, 'Advance deduction') ?? 0;
  const grossAmount = salaryValue(data.gross_amount ?? (amount + advanceDeduction));
  const salaryMonth = payrollMonth(data.salary_month || String(data.paid_on || nepalDateString()).slice(0, 7));
  const employee = await db.get('SELECT id FROM users WHERE id = ?', [data.employee_id]);
  if (!employee) throw Object.assign(new Error('Employee not found.'), { status: 404 });
  if (!data.employee_id) throw Object.assign(new Error('Which employee is this payment for?'), { status: 400 });
  if (amount < 0 || grossAmount <= 0 || advanceDeduction < 0 || positiveMoney(amount + advanceDeduction) !== grossAmount) {
    throw Object.assign(new Error('Gross salary must equal the cash/bank payment plus the advance deduction.'), { status: 400 });
  }
  await ensureAccountingSchema(db);
  // Insert the payment and its journal atomically: Dr Payroll, Cr the medium
  // it was paid from (cash out of the drawer, otherwise bank).
  return db.transaction(async (tx) => {
    const request = await beginPayrollRequest(tx, data.request_key, 'salary_payments', [Number(data.employee_id), amount, grossAmount, advanceDeduction, salaryMonth, date, method, data.note || null], paidBy);
    if (request.replay) return request.replay;
    const businessDayId = await payrollBusinessDay(tx, date);
    if (db.driver === 'postgres') await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [data.employee_id]);
    if (advanceDeduction > await advanceOutstanding(tx, data.employee_id)) throw Object.assign(new Error('Advance deduction cannot exceed the outstanding advance.'), { status: 400 });
    const result = await tx.run(
      `INSERT INTO salary_payments (employee_id, amount, gross_amount, advance_deduction, period_label, paid_on, method, note, paid_by, business_day_id, salary_month)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.employee_id, amount, grossAmount, advanceDeduction, data.period_label || null, date, method, data.note || null, paidBy, businessDayId, salaryMonth]
    );
    const payment = await tx.get(`SELECT * FROM salary_payments WHERE id = ?`, [result.lastInsertRowid]);
    if (grossAmount > 0) {
      const payoutLines = await payrollPayoutLines(tx, { amount, method, date, businessDayId, useBusinessFunding: data.use_business_funding });
      await postJournal(tx, {
        entry_date: date,
        memo: `Salary payment${data.period_label ? ` — ${data.period_label}` : ''}`,
        source_type: 'payroll',
        source_id: payment.id,
        created_by: paidBy,
        business_day_id: businessDayId,
        lines: [
          { code: '5030', debit: grossAmount, credit: 0, memo: 'gross payroll' },
          ...(advanceDeduction > 0 ? [{ code: '1310', debit: 0, credit: advanceDeduction, memo: 'advance deduction' }] : []),
          ...payoutLines,
        ],
      });
    }
    await finishPayrollRequest(tx, request, 'salary_payments', payment.id);
    return payment;
  });
}

export async function deletePayment(db, id) {
  const businessDayId = await currentBusinessDayId(db, { required: true });
  const payment = await db.get(`SELECT * FROM salary_payments WHERE id=?`, [id]);
  if (!payment) throw Object.assign(new Error('Salary payment not found.'), { status: 404 });
  if (Number(payment.business_day_id || 0) !== Number(businessDayId)) {
    throw Object.assign(new Error('A salary payment from a closed business day cannot be deleted.'), { status: 409 });
  }
  await db.transaction(async (tx) => {
    if (db.driver === 'postgres') await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [payment.employee_id]);
    await deleteJournalBySource(tx, 'payroll', id);
    await tx.run(`DELETE FROM salary_payments WHERE id = ?`, [id]);
  });
}

/**
 * One row per employee with the metrics the system can honestly produce.
 * Everything is aggregated in SQL and bounded by the number of employees.
 */
export async function getPerformance(db) {
  const employees = await db.all(
    `SELECT id, full_name, username, role, is_active, hire_date, position FROM users ORDER BY full_name`
  );

  const [orders, bills, wastage] = await Promise.all([
    db.all(
      `SELECT o.waiter_id AS uid,
              COUNT(DISTINCT o.id) AS orders_handled,
              COUNT(DISTINCT date(o.created_at, '+5 hours', '+45 minutes')) AS active_days,
              COALESCE(SUM(oi.subtotal), 0) AS sales,
              MAX(o.created_at) AS last_order_at
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.waiter_id IS NOT NULL
       GROUP BY o.waiter_id`
    ),
    db.all(
      `SELECT b.cashier_id AS uid,
              COUNT(*) AS bills_settled,
              COALESCE(SUM(b.grand_total), 0) AS revenue
       FROM bills b WHERE b.cashier_id IS NOT NULL AND b.status = 'paid'
       GROUP BY b.cashier_id`
    ),
    db.all(
      `SELECT w.employee_id AS uid,
              COUNT(*) AS wastage_entries,
              COALESCE(SUM(w.total_cost), 0) AS wastage_cost
       FROM wastage_log w WHERE w.employee_id IS NOT NULL
       GROUP BY w.employee_id`
    ),
  ]);

  const byId = (rows) => new Map(rows.map((r) => [Number(r.uid), r]));
  const o = byId(orders);
  const b = byId(bills);
  const w = byId(wastage);

  return employees.map((e) => {
    const oo = o.get(Number(e.id)) || {};
    const bb = b.get(Number(e.id)) || {};
    const ww = w.get(Number(e.id)) || {};
    return {
      id: e.id,
      full_name: e.full_name || e.username,
      role: e.role,
      position: e.position || null,
      hire_date: e.hire_date || null,
      is_active: Number(e.is_active) === 1,
      orders_handled: Number(oo.orders_handled || 0),
      active_days: Number(oo.active_days || 0),
      sales: Number(oo.sales || 0),
      last_order_at: oo.last_order_at || null,
      bills_settled: Number(bb.bills_settled || 0),
      revenue: Number(bb.revenue || 0),
      wastage_entries: Number(ww.wastage_entries || 0),
      wastage_cost: Number(ww.wastage_cost || 0),
    };
  });
}
