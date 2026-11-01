import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';
import { ensureColumn } from '@/lib/db/schema-helpers.js';
import { nepalDateString } from '@/lib/report-dates.js';
import { ensureAccountingSchema, postJournal } from '@/lib/accounting.js';
import { payrollBusinessDay } from '@/lib/payroll-payout.js';
import { beginPayrollRequest, finishPayrollRequest } from '@/lib/payroll-requests.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const roundMoney = (n) => Math.round(Number(n) * 100) / 100;
export function payrollMonth(value = nepalDateString().slice(0, 7)) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value)) || Number(String(value).slice(0, 4)) < 2000) fail('Choose a valid salary month (AD).');
  return String(value);
}
export function salaryValue(value, label = 'Salary') {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${label} must be a valid amount.`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${label} must be a valid amount of zero or more.`);
  if (!Number.isSafeInteger(Math.round(n * 100))) fail(`${label} is too large.`);
  return roundMoney(n);
}

export async function ensureMonthlyPayrollSchema(db) {
  if (db.driver === 'postgres') {
    const ready = await db.get("SELECT to_regclass('public.staff_salary_terms') AS terms, to_regclass('public.staff_salary_adjustments') AS adjustments, to_regclass('public.payroll_requests') AS requests");
    if (!ready?.terms || !ready?.adjustments || !ready?.requests) {
      throw Object.assign(new Error('Monthly payroll needs an update. Run npm run db:migrate (through migration 073).'), { status: 503, expose: true });
    }
  }
  await ensureColumn(db, 'users', 'absence_daily_rate', 'DOUBLE PRECISION DEFAULT 0');
  await ensureColumn(db, 'salary_payments', 'salary_month', 'TEXT');
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS payroll_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
    source_table TEXT NOT NULL, source_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS staff_salary_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    effective_month TEXT NOT NULL, salary DOUBLE PRECISION NOT NULL,
    created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(employee_id, effective_month))`);
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS staff_salary_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    salary_month TEXT NOT NULL, kind TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
    absent_days DOUBLE PRECISION DEFAULT 0, daily_rate DOUBLE PRECISION DEFAULT 0,
    note TEXT NOT NULL, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_staff_salary_adjustments_employee_month ON staff_salary_adjustments(employee_id, salary_month)');
  // Start existing salaries this month; do not invent years of historic salary owed.
  await db.run(`INSERT INTO staff_salary_terms (employee_id, effective_month, salary)
    SELECT id, ?, salary FROM users WHERE salary IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM staff_salary_terms t WHERE t.employee_id = users.id)
    ON CONFLICT (employee_id, effective_month) DO NOTHING`, [payrollMonth()]);
}

export async function saveSalaryTerm(db, employeeId, salary, month, actorId) {
  const effective = payrollMonth(month);
  if (effective < payrollMonth()) fail('Salary changes must start this month or a future month.');
  await db.run(`INSERT INTO staff_salary_terms (employee_id, effective_month, salary, created_by)
    VALUES (?, ?, ?, ?) ON CONFLICT (employee_id, effective_month)
    DO UPDATE SET salary = EXCLUDED.salary, created_by = EXCLUDED.created_by`,
  [employeeId, effective, salary ?? 0, actorId]);
}

export function calculateSalaryStatement({ month, terms, payments, advances, adjustments }) {
  month = payrollMonth(month);
  const dateMonth = (v) => String(v).slice(0, 7);
  const sum = (rows, field) => roundMoney(rows.reduce((n, row) => n + Number(row[field] || 0), 0));
  const atMonth = (rows, field, m) => rows.filter((row) => dateMonth(row[field]) === m);
  const sorted = [...terms].sort((a, b) => a.effective_month.localeCompare(b.effective_month));
  const salaryAt = (m) => Number(sorted.filter((t) => t.effective_month <= m).at(-1)?.salary || 0);
  const first = sorted[0]?.effective_month || month;
  let opening = 0;
  // Before tracking began, import only unsettled advance debt. Historic salary
  // payouts have no matching accruals and must not become new staff debt.
  if (month >= first) {
    const legacyAdvances = sum(advances.filter((a) => dateMonth(a.advanced_on) < first), 'amount');
    const legacySettled = sum(payments.filter((p) => dateMonth(p.paid_on) < first), 'advance_deduction');
    const legacyWaived = sum(adjustments.filter((a) => a.salary_month < first && a.kind === 'advance_waiver'), 'amount');
    opening -= Math.max(0, legacyAdvances - legacySettled - legacyWaived);
  }
  for (const a of advances) if (dateMonth(a.advanced_on) >= first && dateMonth(a.advanced_on) < month) opening -= Number(a.amount);
  for (const p of payments) {
    const period = p.salary_month || dateMonth(p.paid_on);
    if (period >= first && period < month) opening -= Number(p.amount);
  }
  for (const a of adjustments) if (a.salary_month >= first && a.salary_month < month) opening += (a.kind === 'absence' ? -1 : 1) * Number(a.amount);
  let cursor = first;
  while (cursor < month) {
    opening += salaryAt(cursor);
    const [y, m] = cursor.split('-').map(Number);
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  const monthlyAdjustments = adjustments.filter((a) => a.salary_month === month);
  const salary = salaryAt(month);
  const advanced = sum(atMonth(advances, 'advanced_on', month), 'amount');
  const paid = sum(payments.filter((p) => (p.salary_month || dateMonth(p.paid_on)) === month), 'amount');
  const advanceSettled = sum(payments.filter((p) => (p.salary_month || dateMonth(p.paid_on)) === month), 'advance_deduction');
  const absences = sum(monthlyAdjustments.filter((a) => a.kind === 'absence'), 'amount');
  const absenceWaived = sum(monthlyAdjustments.filter((a) => a.kind === 'absence_waiver'), 'amount');
  const waived = sum(monthlyAdjustments.filter((a) => a.kind !== 'absence'), 'amount');
  const balance = roundMoney(opening + salary - advanced - paid - absences + waived);
  return { month, tracking_start: first, opening: roundMoney(opening), salary, advanced, paid, advance_settled: advanceSettled, absences, waived,
    balance, remaining: Math.max(0, balance), carry_forward_deduction: Math.max(0, -balance),
    available_for_advance_settlement: Math.max(0, roundMoney(salary - absences + absenceWaived - paid - advanceSettled)) };
}

export async function monthlySalaryDetails(db, employeeId, month) {
  month = payrollMonth(month);
  const employee = await db.get('SELECT id, salary, absence_daily_rate FROM users WHERE id = ?', [employeeId]);
  if (!employee) fail('Employee not found.', 404);
  const terms = await db.all('SELECT * FROM staff_salary_terms WHERE employee_id = ? ORDER BY effective_month', [employeeId]);
  const adjustments = await db.all(`SELECT a.*, u.full_name AS created_by_name FROM staff_salary_adjustments a
    LEFT JOIN users u ON u.id = a.created_by WHERE employee_id = ? ORDER BY a.id DESC`, [employeeId]);
  const payments = await db.all('SELECT * FROM salary_payments WHERE employee_id = ?', [employeeId]);
  const advances = await db.all('SELECT * FROM salary_advances WHERE employee_id = ?', [employeeId]);
  const setting = await db.get("SELECT setting_value FROM system_settings WHERE setting_key = 'payroll_absence_deductions_enabled'");
  return { statement: calculateSalaryStatement({ month, terms, payments, advances, adjustments }), terms, adjustments,
    absence_daily_rate: Number(employee.absence_daily_rate || 0), absence_enabled: setting?.setting_value === 'true' };
}

export async function recordSalaryAdjustment(db, data, actorId) {
  const month = payrollMonth(data.salary_month);
  const kind = data.type;
  if (!['absence', 'advance_waiver', 'absence_waiver'].includes(kind)) fail('Choose an adjustment type.');
  const note = String(data.note || '').trim();
  if (note.length < 3) fail('Enter a reason for this salary adjustment.');
  await ensureAccountingSchema(db);
  return db.transaction(async (tx) => {
    const request = await beginPayrollRequest(tx, data.request_key, 'staff_salary_adjustments',
      [Number(data.employee_id), month, kind, Number(data.absent_days || 0), data.amount == null ? null : Number(data.amount), note], actorId);
    if (request.replay) return request.replay;
    const businessDayId = kind === 'advance_waiver' ? await payrollBusinessDay(tx, nepalDateString()) : null;
    // Serialize adjustments and payments for the same employee on PostgreSQL.
    if (db.driver === 'postgres') await tx.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [data.employee_id]);
    const details = await monthlySalaryDetails(tx, data.employee_id, month);
    if (kind === 'absence' && (month > payrollMonth() || month < details.statement.tracking_start || !details.terms.length)) {
      fail('Record absent days in a salary month that has already started.');
    }
    const days = Number(data.absent_days || 0);
    const rate = details.absence_daily_rate;
    let amount = salaryValue(data.amount, 'Waiver');
    if (kind === 'absence') {
      if (!details.absence_enabled) fail('Enable absence deductions in Settings first.');
      if (!Number.isFinite(days) || days <= 0 || days > 31 || !(rate > 0)) fail('Enter absent days (up to 31) and set a daily deduction rate on the staff record.');
      const already = details.adjustments.filter((a) => a.salary_month === month && a.kind === 'absence').reduce((n, a) => n + Number(a.absent_days), 0);
      const [y, m] = month.split('-').map(Number);
      if (already + days > new Date(Date.UTC(y, m, 0)).getUTCDate()) fail('Total absent days exceed the number of days in this month.');
      amount = roundMoney(days * rate);
    } else {
      if (!(amount > 0)) fail('Enter a waiver amount greater than zero.');
      if (kind === 'absence_waiver') {
        const available = details.adjustments.filter((a) => a.salary_month === month && ['absence', 'absence_waiver'].includes(a.kind))
          .reduce((n, a) => n + (a.kind === 'absence' ? 1 : -1) * Number(a.amount), 0);
        if (amount > roundMoney(available)) fail('Waiver exceeds this month’s remaining absence deductions.');
      } else {
        const { advanceOutstanding } = await import('@/lib/payroll.js');
        if (amount > await advanceOutstanding(tx, data.employee_id)) fail('Waiver exceeds the outstanding advance.');
        if (month !== payrollMonth()) fail('Advance waivers must be recorded in the current month.');
      }
    }
    const result = await tx.run(`INSERT INTO staff_salary_adjustments
      (employee_id, salary_month, kind, amount, absent_days, daily_rate, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [data.employee_id, month, kind, amount, kind === 'absence' ? days : 0, kind === 'absence' ? rate : 0, note, actorId]);
    if (kind === 'advance_waiver') await postJournal(tx, {
      source_type: 'salary_advance_waiver', source_id: result.lastInsertRowid, created_by: actorId,
      business_day_id: businessDayId, memo: `Staff advance waived: ${note}`,
      lines: [{ code: '5030', debit: amount, credit: 0 }, { code: '1310', debit: 0, credit: amount }],
    });
    await finishPayrollRequest(tx, request, 'staff_salary_adjustments', result.lastInsertRowid);
    return tx.get('SELECT * FROM staff_salary_adjustments WHERE id = ?', [result.lastInsertRowid]);
  });
}
