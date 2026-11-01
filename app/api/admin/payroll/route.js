import { monthlySalaryDetails, recordSalaryAdjustment, calculateSalaryStatement, payrollMonth } from '@/lib/payroll-months.js';
import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { accountBalance, ensureAccountingSchema } from '@/lib/accounting.js';
import {
  advanceOutstanding,
  deleteAdvance,
  deletePayment,
  ensurePayrollSchema,
  listAdvances,
  listPayments,
  listPayrollOverview,
  recordAdvance,
  recordPayment,
} from '@/lib/payroll.js';

export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'payroll.view' });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    await ensurePayrollSchema(db);
    await ensureAccountingSchema(db);
    const fundingAvailable = await accountBalance(db, '1050');
    const params = new URL(request.url).searchParams;
    const employeeId = params.get('employee_id');
    if (employeeId) {
      const [payments, advances, outstanding] = await Promise.all([
        listPayments(db, employeeId),
        listAdvances(db, employeeId),
        advanceOutstanding(db, employeeId),
      ]);
      const details = await monthlySalaryDetails(db, employeeId, params.get('month') || undefined);
      return NextResponse.json({ payments, advances, outstanding, ...details, funding_available: fundingAvailable, can_adjust: auth.user.role === 'admin' });
    }
    const [employees, advances, payments, terms, adjustments] = await Promise.all([
      listPayrollOverview(db),
      listAdvances(db),
      listPayments(db),
      db.all('SELECT * FROM staff_salary_terms'),
      db.all('SELECT * FROM staff_salary_adjustments'),
    ]);
    const month = payrollMonth(params.get('month') || undefined);
    const withBalances = employees.map((employee) => {
      const own = (rows) => rows.filter((row) => Number(row.employee_id) === Number(employee.id));
      const statement = calculateSalaryStatement({ month, terms: own(terms), adjustments: own(adjustments), advances: own(advances), payments: own(payments) });
      return { ...employee, current_month_salary: statement.salary, remaining_salary: statement.remaining, carry_forward_deduction: statement.carry_forward_deduction };
    });
    return NextResponse.json({ employees: withBalances, advances, payments });
  } catch (error) {
    return handleRouteError(error, 'Failed to load payroll');
  }
}

export async function POST(request) {
  try {
    const data = await request.json();
    const isAdvance = data.type === 'advance';
    const isAdjustment = ['absence', 'advance_waiver', 'absence_waiver'].includes(data.type);
    const auth = await requireAuth(request, isAdjustment ? { roles: ['admin'] } : isAdvance
      ? { roles: ['admin', 'cashier'], permission: 'payroll.advances.create' }
      : { roles: ['admin', 'cashier'], permission: 'payroll.payments.create' });
    if (auth.error) return auth.error;
    if (data.type != null && !['advance', 'payment', 'absence', 'advance_waiver', 'absence_waiver'].includes(data.type)) {
      return NextResponse.json({ error: 'Choose a valid payroll action.' }, { status: 400 });
    }
    const db = Database.getInstance();
    await ensurePayrollSchema(db);
    if (isAdjustment) {
      const adjustment = await recordSalaryAdjustment(db, data, auth.user.id);
      return NextResponse.json({ adjustment }, { status: 201 });
    }
    if (isAdvance) {
      const advance = await recordAdvance(db, data, auth.user?.id || null);
      return NextResponse.json({ message: 'Salary advance recorded.', advance }, { status: 201 });
    }
    const payment = await recordPayment(db, data, auth.user?.id || null);
    return NextResponse.json({ message: 'Salary payment recorded.', payment }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, 'Failed to record payment');
  }
}

export async function DELETE(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'payroll.records.delete' });
    if (auth.error) return auth.error;
    const params = new URL(request.url).searchParams;
    const id = params.get('id');
    if (!id) return NextResponse.json({ error: 'Which payment should be removed?' }, { status: 400 });
    if (params.get('type') && !['advance', 'payment'].includes(params.get('type'))) return NextResponse.json({ error: 'Choose a valid payroll record type.' }, { status: 400 });
    const db = Database.getInstance();
    await ensurePayrollSchema(db);
    if (params.get('type') === 'advance') {
      await deleteAdvance(db, id);
      return NextResponse.json({ message: 'Advance deleted.' });
    }
    await deletePayment(db, id);
    return NextResponse.json({ message: 'Payment deleted.' });
  } catch (error) {
    return handleRouteError(error, 'Failed to delete payment');
  }
}
