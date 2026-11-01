/**
 * Primary (first) admin is the oldest admin account by id.
 * That account cannot be deleted or deactivated.
 */

export async function getPrimaryAdminId(db) {
  const row = await db.get(`
    SELECT id FROM users
    WHERE role = 'admin'
    ORDER BY id ASC
    LIMIT 1
  `);
  return row?.id ?? null;
}

export async function isPrimaryAdmin(db, userId) {
  const primaryId = await getPrimaryAdminId(db);
  return primaryId != null && Number(primaryId) === Number(userId);
}

/** Keep the staff identity attached to every salary calculation and payout. */
export async function assertPayrollAllowsEmployeeDeletion(db, userId) {
  if (db.driver === 'postgres') await db.get('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  const row = await db.get(`SELECT
    (SELECT COUNT(*) FROM salary_advances WHERE employee_id = ?) +
    (SELECT COUNT(*) FROM salary_payments WHERE employee_id = ?) +
    (SELECT COUNT(*) FROM staff_salary_terms WHERE employee_id = ?) +
    (SELECT COUNT(*) FROM staff_salary_adjustments WHERE employee_id = ?) AS records`, [userId, userId, userId, userId]);
  if (Number(row?.records) > 0) throw Object.assign(new Error('This staff member has payroll history. Deactivate them instead to preserve salary calculations and payments.'), { status: 409, code: 'employee_payroll_in_use' });
}
