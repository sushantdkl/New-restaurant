import { NextResponse } from 'next/server';
import Database from '@/lib/db/index.js';
import { handleRouteError } from '@/lib/api-guard.js';

/** Active staff for the login picker (no password hashes). */
export async function GET() {
  try {
    const db = Database.getInstance();
    const users = await db.all(`
      SELECT username, full_name, role
      FROM users
      WHERE COALESCE(is_active, 1) = 1
      ORDER BY
        CASE role
          WHEN 'admin' THEN 1
          WHEN 'cashier' THEN 2
          WHEN 'waiter' THEN 3
          WHEN 'kitchen' THEN 4
          ELSE 5
        END,
        full_name
    `);
    return NextResponse.json({ users: users || [] });
  } catch (error) {
    return handleRouteError(error, 'Could not load users.');
  }
}
