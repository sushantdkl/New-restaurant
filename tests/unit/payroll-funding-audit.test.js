import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PosDatabase } from '../../lib/db/index.js';
import { ensurePayrollSchema, recordAdvance, recordPayment, deleteAdvance, deletePayment, advanceOutstanding } from '../../lib/payroll.js';
import { saveSalaryTerm, monthlySalaryDetails, recordSalaryAdjustment, salaryValue, calculateSalaryStatement } from '../../lib/payroll-months.js';
import { addBusinessInvestment, businessFundingProfile } from '../../lib/business-funding.js';
import { accountBalance, postJournal } from '../../lib/accounting.js';
import { openBusinessDay, currentBusinessDayId } from '../../lib/business-days.js';
import { ensureReportSchema } from '../../lib/reports.js';
import { buildSummaryReport } from '../../lib/summary-report.js';
import { nepalDateString } from '../../lib/report-dates.js';

const dbPath = path.join(os.tmpdir(), `payroll-funding-audit-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(dbPath);
const today = nepalDateString();
const month = today.slice(0, 7);
const actor = { id: 1, role: 'admin', full_name: 'Audit Admin' };
let employeeId, advance, splitPayment, fundedPayment;
const balances = async () => Promise.all(['1010', '1020', '1050'].map((code) => accountBalance(db, code)));
const report = () => buildSummaryReport(db, { start: today, end: today });
test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(dbPath + suffix); } catch { /* closed */ }
});

test('set up a monthly salary, Rs 1,000 drawer and Rs 6,000 funding', async () => {
  await ensurePayrollSchema(db);
  employeeId = (await db.get("SELECT id FROM users WHERE role = 'waiter' LIMIT 1")).id;
  await db.run('UPDATE users SET salary = 20000, absence_daily_rate = 500 WHERE id = ?', [employeeId]);
  await saveSalaryTerm(db, employeeId, 20000, month, actor.id);
  await openBusinessDay(db, { business_date: today, opening_cash: 1000 }, actor);
  await addBusinessInvestment(db, { amount: 6000, date: today, createdBy: actor.id });
  await ensureReportSchema(db);
  assert.deepEqual(await balances(), [1000, 0, 6000]);
});

test('invalid money, methods and dates cannot create records or journals', async () => {
  for (const amount of [true, [], {}, 'NaN', Infinity, -10, 1e30]) assert.throws(() => salaryValue(amount));
  const before = (await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n;
  for (const data of [
    { amount: 10, method: 'made_up_bank' }, { amount: 10, method: 'owner_pocket' },
    { amount: 10, advanced_on: '2026-02-30' }, { amount: 10, advanced_on: '2099-01-01' },
    { amount: 0.001 },
  ]) await assert.rejects(() => recordAdvance(db, { employee_id: employeeId, ...data }, actor.id), (error) => error.status === 400);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM salary_advances')).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, before);
});

test('funded advance changes funding and staff balance while leaving cash and bank untouched', async () => {
  advance = await recordAdvance(db, { employee_id: employeeId, amount: 2000, method: 'business_funding', request_key: 'funded-advance-1' }, actor.id);
  assert.deepEqual(await balances(), [1000, 0, 4000]);
  const profile = await businessFundingProfile(db);
  assert.equal(profile.totalUsed, 2000);
  assert.ok(profile.history.some((row) => row.source_type === 'salary_advance' && Number(row.amount) === -2000));
  const details = await monthlySalaryDetails(db, employeeId, month);
  assert.equal(details.statement.remaining, 18000);
});

test('cash shortfall rolls back until approved; retry posts exactly once', async () => {
  const data = { employee_id: employeeId, amount: 1500, method: 'cash', request_key: 'split-payment-1' };
  await assert.rejects(() => recordPayment(db, data, actor.id), (error) => error.code === 'business_funding_required' && error.shortfall === 500);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM salary_payments')).n, 0);
  assert.deepEqual(await balances(), [1000, 0, 4000]);
  splitPayment = await recordPayment(db, { ...data, use_business_funding: true }, actor.id);
  const retry = await recordPayment(db, data, actor.id);
  assert.equal(retry.id, splitPayment.id);
  assert.deepEqual(await balances(), [0, 0, 3500]);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM salary_payments')).n, 1);
  await assert.rejects(() => recordPayment(db, { ...data, amount: 1600 }, actor.id), (error) => error.code === 'payroll_request_conflict');
});

test('funded salary settles an advance once and summary uses journal funding splits', async () => {
  const data = { employee_id: employeeId, amount: 1000, gross_amount: 3000, advance_deduction: 2000, method: 'business_funding', request_key: 'funded-payment-1' };
  fundedPayment = await recordPayment(db, data, actor.id);
  assert.equal((await recordPayment(db, data, actor.id)).id, fundedPayment.id);
  assert.equal(await advanceOutstanding(db, employeeId), 0);
  assert.deepEqual(await balances(), [0, 0, 2500]);
  assert.equal((await monthlySalaryDetails(db, employeeId, month)).statement.remaining, 15500);
  const summary = await report();
  assert.equal(summary.salary.cash, 1000);
  assert.equal(summary.salary.bank, 0);
  assert.equal(summary.salary.funding, 1500);
  assert.equal(summary.salary.net_paid, 2500);
  assert.equal(summary.salary.advance_deductions, 2000);
  assert.equal(summary.salary.total, 4500);
  const profile = await businessFundingProfile(db);
  assert.equal(profile.totalUsed, 3500);
  assert.equal(profile.history.filter((row) => row.source_type === 'payroll').length, 2);
});

test('insufficient funding rejects payment without partial changes', async () => {
  const before = (await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n;
  await assert.rejects(() => recordPayment(db, { employee_id: employeeId, amount: 3000, method: 'business_funding' }, actor.id), (error) => error.code === 'business_funding_insufficient');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM salary_payments')).n, 2);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, before);
  assert.deepEqual(await balances(), [0, 0, 2500]);
});

test('deletion returns funds to their original sources and removed request keys cannot recreate a payout', async () => {
  await deletePayment(db, fundedPayment.id);
  assert.deepEqual(await balances(), [0, 0, 3500]);
  assert.equal(await advanceOutstanding(db, employeeId), 2000);
  await assert.rejects(() => recordPayment(db, { employee_id: employeeId, amount: 1000, gross_amount: 3000, advance_deduction: 2000, method: 'business_funding', request_key: 'funded-payment-1' }, actor.id), /removed/);
  await assert.rejects(() => deletePayment(db, fundedPayment.id), (error) => error.status === 404);
  await deletePayment(db, splitPayment.id);
  assert.deepEqual(await balances(), [1000, 0, 4000]);
  await deleteAdvance(db, advance.id);
  assert.deepEqual(await balances(), [1000, 0, 6000]);
  assert.equal((await report()).salary.total, 0);
});

test('online shortfall uses funding without changing the drawer or misreporting bank outflow', async () => {
  await postJournal(db, { entry_date: today, memo: 'Audit bank balance', lines: [{ code: '1020', debit: 200, credit: 0 }, { code: '3010', debit: 0, credit: 200 }] });
  await recordPayment(db, { employee_id: employeeId, amount: 500, method: 'bank_transfer', use_business_funding: true }, actor.id);
  const summary = await report();
  assert.equal(summary.salary.cash, 0);
  assert.equal(summary.salary.bank, 200);
  assert.equal(summary.salary.funding, 300);
  assert.deepEqual(await balances(), [1000, 0, 5700]);
});

test('backdated payroll belongs to its dated business day and cannot be deleted from the current day', async () => {
  const past = new Date(`${today}T00:00:00Z`); past.setUTCDate(past.getUTCDate() - 1);
  const date = past.toISOString().slice(0, 10);
  const advance = await recordAdvance(db, { employee_id: employeeId, amount: 100, method: 'business_funding', advanced_on: date }, actor.id);
  assert.notEqual(Number(advance.business_day_id), Number(await currentBusinessDayId(db)));
  const journal = await db.get("SELECT entry_date, business_day_id FROM journal_entries WHERE source_type = 'salary_advance' AND source_id = ?", [advance.id]);
  assert.equal(journal.entry_date, date);
  assert.equal(Number(journal.business_day_id), Number(advance.business_day_id));
  await assert.rejects(() => deleteAdvance(db, advance.id), (error) => error.status === 409);
});

test('absence retries retain the original rate and waivers cannot repeat or exceed deductions', async () => {
  await db.run("INSERT INTO system_settings (setting_key, setting_value) VALUES ('payroll_absence_deductions_enabled', 'true') ON CONFLICT(setting_key) DO UPDATE SET setting_value='true'");
  const data = { employee_id: employeeId, salary_month: month, type: 'absence', absent_days: 2, note: 'Manual absent days', request_key: 'absence-request-1' };
  const absence = await recordSalaryAdjustment(db, data, actor.id);
  await db.run('UPDATE users SET absence_daily_rate = 800 WHERE id = ?', [employeeId]);
  const retry = await recordSalaryAdjustment(db, data, actor.id);
  assert.equal(retry.id, absence.id);
  assert.equal(Number(retry.amount), 1000);
  await assert.rejects(() => recordSalaryAdjustment(db, { ...data, absent_days: 32, request_key: 'absence-too-many-days' }, actor.id), /absent days/i);
  const waiver = { employee_id: employeeId, salary_month: month, type: 'absence_waiver', amount: 1000, note: 'Approved paid leave', request_key: 'absence-waiver-1' };
  const first = await recordSalaryAdjustment(db, waiver, actor.id);
  assert.equal((await recordSalaryAdjustment(db, waiver, actor.id)).id, first.id);
  await assert.rejects(() => recordSalaryAdjustment(db, { ...waiver, request_key: 'absence-waiver-2' }, actor.id), /exceeds/);
});

test('suggested advance settlement includes waived absence days and does not repeat a settled salary', () => {
  const input = { month, terms: [{ effective_month: month, salary: 20000 }],
    advances: [{ advanced_on: `${month}-01`, amount: 25000 }], payments: [],
    adjustments: [{ salary_month: month, kind: 'absence', amount: 1000 }, { salary_month: month, kind: 'absence_waiver', amount: 1000 }] };
  assert.equal(calculateSalaryStatement(input).available_for_advance_settlement, 20000);
  const settled = calculateSalaryStatement({ ...input, payments: [{ salary_month: month, paid_on: today, amount: 0, advance_deduction: 20000 }] });
  assert.equal(settled.available_for_advance_settlement, 0);
  assert.equal(settled.carry_forward_deduction, 5000);
});
