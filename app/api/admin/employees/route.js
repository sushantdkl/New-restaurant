import { NextResponse } from 'next/server';
import Database from '@/lib/db/index';
import bcrypt from 'bcryptjs';
import { assertPayrollAllowsEmployeeDeletion, getPrimaryAdminId } from '@/lib/employees.js';
import { ensurePayrollSchema } from '@/lib/payroll.js';
import { ensureHrmSchema } from '@/lib/hrm.js';
import { salaryValue, saveSalaryTerm, payrollMonth } from '@/lib/payroll-months.js';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';

export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'employees.manage' });
    if (auth.error) return auth.error;

    const db = Database.getInstance();
    await ensurePayrollSchema(db);
    await ensureHrmSchema(db);
    const primaryId = await getPrimaryAdminId(db);

    const employees = await db.all(`
      SELECT u.id, u.username, u.full_name, u.role, u.email, u.phone, u.is_active, u.created_at,
             u.salary, u.absence_daily_rate, u.hire_date, u.position, u.department_id, u.designation_id,
             dep.name AS department_name, des.name AS designation_name
      FROM users u
      LEFT JOIN departments dep ON dep.id = u.department_id
      LEFT JOIN designations des ON des.id = u.designation_id
      ORDER BY u.id ASC
    `);

    return NextResponse.json({
      primary_admin_id: primaryId,
      employees: employees.map((e) => ({
        ...e,
        is_active: Number(e.is_active) === 1,
        is_primary_admin: Number(e.id) === Number(primaryId),
      })),
    });
  } catch (error) {
    console.error('Get employees error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch employees' },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'employees.manage' });
    if (auth.error) return auth.error;

    const data = await request.json();
    data.username = String(data.username || '').trim();
    if (auth.user.role !== 'admin' && data.role === 'admin') {
      return NextResponse.json({ error: 'Only an administrator can create another administrator.' }, { status: 403 });
    }
    const db = Database.getInstance();
    await ensurePayrollSchema(db);
    await ensureHrmSchema(db);

    // Check if username already exists
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [data.username]);
    if (existing) {
      return NextResponse.json(
        { error: 'Username already exists' },
        { status: 400 }
      );
    }

    if (!data.username || !String(data.full_name || '').trim()) return NextResponse.json({ error: 'Enter the staff name and username.' }, { status: 400 });
    if (!/^[0-9]{4}$/.test(String(data.pin || ''))) return NextResponse.json({ error: 'Enter a four digit PIN.' }, { status: 400 });
    if (!['admin', 'cashier', 'waiter', 'kitchen'].includes(data.role)) return NextResponse.json({ error: 'Choose a valid staff role.' }, { status: 400 });
    const salary = salaryValue(data.salary);
    const dailyRate = salaryValue(data.absence_daily_rate, 'Daily absence deduction') ?? 0;
    const effectiveMonth = payrollMonth(data.salary_effective_month || undefined);
    if (effectiveMonth < payrollMonth()) return NextResponse.json({ error: 'Salary must start this month or a future month.' }, { status: 400 });
    const hashedPassword = bcrypt.hashSync(String(data.pin), 10);
    const employee = await db.transaction(async (tx) => {

      const result = await tx.run(`
        INSERT INTO users (
          username, full_name, role, password_hash, email, phone, is_active,
          salary, hire_date, position, department_id, designation_id, absence_daily_rate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        data.username,
        data.full_name,
        data.role,
        hashedPassword,
        data.email || null,
        data.phone || null,
        data.is_active === false ? 0 : 1,
        salary,
        data.hire_date || null,
        data.position || null,
        data.department_id ? Number(data.department_id) : null,
        data.designation_id ? Number(data.designation_id) : null,
        dailyRate,
      ]);

      if (salary != null) await saveSalaryTerm(tx, result.lastInsertRowid, salary, effectiveMonth, auth.user.id);
      return tx.get(`
        SELECT id, username, full_name, role, email, phone, is_active, created_at,
               salary, absence_daily_rate, hire_date, position, department_id, designation_id
        FROM users WHERE id = ?
      `, [result.lastInsertRowid]);
    });

    return NextResponse.json({ 
      message: 'Employee created successfully',
      employee 
    }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, 'Failed to create employee');
  }
}

export async function PUT(request) {
  const data = await request.clone().json();
  if (!data.id) return NextResponse.json({ error: 'Employee ID is required.' }, { status: 400 });
  const { PUT: updateEmployee } = await import('./[id]/route.js');
  return updateEmployee(request, { params: Promise.resolve({ id: data.id }) });
}

export async function DELETE(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'employees.manage' });
    if (auth.error) return auth.error;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Employee ID is required.' }, { status: 400 });
    }

    // Prefer /api/admin/employees/[id] — keep this for compatibility
    const db = Database.getInstance();
    await ensurePayrollSchema(db);
    const { isPrimaryAdmin } = await import('@/lib/employees.js');
    const userId = Number(id);

    const existing = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
    if (!existing) {
      return NextResponse.json({ error: 'Employee not found.' }, { status: 404 });
    }
    if (auth.user.role !== 'admin' && existing.role === 'admin') {
      return NextResponse.json({ error: 'Only an administrator can delete an administrator account.' }, { status: 403 });
    }
    if (await isPrimaryAdmin(db, userId)) {
      return NextResponse.json(
        {
          error: 'The main admin account is protected and cannot be deleted.',
          code: 'primary_admin_protected',
        },
        { status: 403 }
      );
    }

    await db.transaction(async (tx) => {
      await assertPayrollAllowsEmployeeDeletion(tx, userId);
      try { await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]); } catch { /* optional */ }
      try { await db.run('DELETE FROM devices WHERE user_id = ?', [userId]); } catch { /* optional */ }
      try { await db.run('UPDATE tables SET waiter_id = NULL WHERE waiter_id = ?', [userId]); } catch { /* optional */ }
      try { await db.run('UPDATE orders SET waiter_id = NULL WHERE waiter_id = ?', [userId]); } catch { /* optional */ }
      try { await db.run('UPDATE bills SET cashier_id = NULL WHERE cashier_id = ?', [userId]); } catch { /* optional */ }
      await db.run('DELETE FROM users WHERE id = ?', [userId]);
    });

    return NextResponse.json({
      message: 'Employee deleted successfully.',
    });
  } catch (error) {
    if (error.code === 'employee_payroll_in_use') return handleRouteError(error);
    console.error('Delete employee error:', error);
    const msg = String(error?.message || '');
    if (/FOREIGN KEY|foreign key/i.test(msg)) {
      return NextResponse.json(
        {
          error: 'This employee is linked to past orders or bills, so they cannot be deleted. Deactivate them instead.',
          code: 'employee_in_use',
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to delete employee' },
      { status: 500 }
    );
  }
}
