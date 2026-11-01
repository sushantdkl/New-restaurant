import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DB_NAME = `staff-payroll-test-${process.pid}-${Date.now()}.db`;
const Database = (await import('../../lib/db/index.js')).default;
const db = Database.getInstance();
const { POST } = await import('../../app/api/admin/employees/route.js');
const { calculateSalaryStatement } = await import('../../lib/payroll-months.js');
const { PUT } = await import('../../app/api/admin/employees/[id]/route.js');
const { DELETE: deleteStaff } = await import('../../app/api/admin/employees/[id]/route.js');
const { DELETE: deleteLegacyStaff } = await import('../../app/api/admin/employees/route.js');
const { POST: payrollPost, GET: payrollGet } = await import('../../app/api/admin/payroll/route.js');
const { openBusinessDay } = await import('../../lib/business-days.js');
const { nepalDateString } = await import('../../lib/report-dates.js');
const { advanceOutstanding } = await import('../../lib/payroll.js');
const token = 'staff-payroll-admin-test';
let employeeId;
const request = (url, body, session = token) => new Request(`http://localhost${url}`, {
  method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
test.after(async () => {
  await Database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join('databases', process.env.DB_NAME) + suffix); } catch { /* closed */ }
  }
});

test('create staff with monthly salary, hire date and deduction rate', async () => {
  const admin = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", [admin.id, token]);
  const response = await POST(new Request('http://localhost/api/admin/employees', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'salary-staff', full_name: 'Salary Staff', role: 'waiter', pin: '1234',
      salary: '20000.50', hire_date: '2026-10-01', absence_daily_rate: '500', is_active: true }),
  }));
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(Number(data.employee.salary), 20000.50);
  assert.equal(Number(data.employee.absence_daily_rate), 500);
  employeeId = data.employee.id;
});

test('legacy settled advances and historic salaries do not become new salary debt', () => {
  const statement = calculateSalaryStatement({ month: '2026-10', terms: [{ effective_month: '2026-10', salary: 20000 }],
    advances: [{ advanced_on: '2026-09-01', amount: 5000 }],
    payments: [{ paid_on: '2026-09-30', amount: 15000, advance_deduction: 5000 }], adjustments: [] });
  assert.equal(statement.opening, 0);
  assert.equal(statement.remaining, 20000);
});

test('staff edit stores salary rate history and per day rate atomically', async () => {
  const response = await PUT(request(`/api/admin/employees/${employeeId}`, { salary: 21000, absence_daily_rate: 600 }), { params: Promise.resolve({ id: employeeId }) });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const data = await response.json();
  assert.equal(Number(data.employee.salary), 21000);
  assert.equal(Number(data.employee.absence_daily_rate), 600);
});

test('advances, absence toggle, rate snapshots and partial waivers update the balance once', async () => {
  const admin = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  await openBusinessDay(db, { business_date: nepalDateString(), opening_cash: 50000 }, { ...admin, role: 'admin' });
  const month = nepalDateString().slice(0, 7);
  const post = async (body, status = 201) => {
    const response = await payrollPost(request('/api/admin/payroll', { employee_id: employeeId, salary_month: month, note: 'Test adjustment', ...body }));
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  await post({ type: 'advance', amount: 25000, method: 'cash' });
  await post({ type: 'absence', absent_days: 2 }, 400);
  await db.run("INSERT INTO system_settings (setting_key, setting_value) VALUES ('payroll_absence_deductions_enabled', 'true') ON CONFLICT(setting_key) DO UPDATE SET setting_value = 'true'");
  await post({ type: 'absence', absent_days: 2 });
  await db.run('UPDATE users SET absence_daily_rate = 900 WHERE id = ?', [employeeId]);
  await post({ type: 'absence_waiver', amount: 200 });
  await post({ type: 'absence_waiver', amount: 1001 }, 400);
  await post({ type: 'advance_waiver', amount: 3000 });
  assert.equal(await advanceOutstanding(db, employeeId), 22000);
  await post({ type: 'advance_waiver', amount: 22001 }, 400);
  const response = await payrollGet(new Request(`http://localhost/api/admin/payroll?employee_id=${employeeId}&month=${month}`, { headers: { Authorization: `Bearer ${token}` } }));
  const details = await response.json();
  assert.equal(response.status, 200);
  assert.equal(details.statement.balance, -2000); // 21000 - 25000 - 1200 + 200 + 3000
  assert.equal(Number(details.adjustments.find((a) => a.kind === 'absence').daily_rate), 600);
  await db.run("UPDATE system_settings SET setting_value = 'false' WHERE setting_key = 'payroll_absence_deductions_enabled'");
  await post({ type: 'absence', absent_days: 1 }, 400);
  const adjustmentJournal = await db.get("SELECT id FROM journal_entries WHERE source_type = 'salary_advance_waiver'");
  assert.ok(adjustmentJournal.id);
  const total = await db.get('SELECT SUM(debit) AS dr, SUM(credit) AS cr FROM journal_lines WHERE journal_id = ?', [adjustmentJournal.id]);
  assert.equal(Number(total.dr), 3000);
  assert.equal(Number(total.cr), 3000);
});

test('cashier cannot waive deductions or record absence adjustments', async () => {
  const cashier = await db.get("SELECT id FROM users WHERE role = 'cashier' LIMIT 1");
  await db.run("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'staff-cashier', datetime('now', '+1 day'))", [cashier.id]);
  const response = await payrollPost(request('/api/admin/payroll', { type: 'advance_waiver', employee_id: employeeId, amount: 100, note: 'Unauthorized waiver' }, 'staff-cashier'));
  assert.equal(response.status, 403);
});

test('advance waiver is a salary expense without another cash payout in the summary', async () => {
  const { ensureReportSchema } = await import('../../lib/reports.js');
  const { buildSummaryReport } = await import('../../lib/summary-report.js');
  await ensureReportSchema(db);
  const report = await buildSummaryReport(db, { start: nepalDateString(), end: nepalDateString() });
  assert.equal(report.salary.total, 3000);
  assert.equal(report.salary.net_paid, 0);
});

test('invalid salary is rejected without creating a staff record', async () => {
  const response = await POST(request('/api/admin/employees', { username: 'invalid-salary', full_name: 'Invalid Salary', pin: '1234', role: 'waiter', salary: 'abc' }));
  assert.equal(response.status, 400);
  assert.equal(await db.get("SELECT id FROM users WHERE username = 'invalid-salary'"), undefined);
});

test('both staff deletion routes preserve payroll history and the staff record', async () => {
  const headers = { Authorization: `Bearer ${token}` };
  const response = await deleteStaff(new Request(`http://localhost/api/admin/employees/${employeeId}`, { method: 'DELETE', headers }), { params: Promise.resolve({ id: employeeId }) });
  assert.equal(response.status, 409, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).code, 'employee_payroll_in_use');
  const legacy = await deleteLegacyStaff(new Request(`http://localhost/api/admin/employees?id=${employeeId}`, { method: 'DELETE', headers }));
  assert.equal(legacy.status, 409);
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', [employeeId]));
});

test('balances carry advances once, unpaid salary and salary rate history', () => {
  const input = { month: '2026-11', terms: [{ effective_month: '2026-10', salary: 20000 }, { effective_month: '2026-11', salary: 22000 }],
    advances: [{ advanced_on: '2026-10-05', amount: 25000 }],
    payments: [{ salary_month: '2026-11', amount: 5000, gross_amount: 10000, advance_deduction: 5000 }],
    adjustments: [{ salary_month: '2026-11', kind: 'absence', amount: 1000 }, { salary_month: '2026-11', kind: 'advance_waiver', amount: 2000 }] };
  const statement = calculateSalaryStatement(input);
  assert.equal(statement.opening, -5000);
  assert.equal(statement.balance, 13000);
  assert.equal(calculateSalaryStatement({ ...input, month: '2026-10' }).carry_forward_deduction, 5000);
});
