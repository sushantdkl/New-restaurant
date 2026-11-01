import { NextResponse } from 'next/server';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { queueTestPrint } from '@/lib/print-jobs.js';

/** Queue a test page for the kitchen or bar printer. */
export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'settings.manage' });
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const db = Database.getInstance();
    const { id } = await queueTestPrint(db, { station: body.station === 'bar' ? 'bar' : 'main', actor: auth.user });
    return NextResponse.json({ success: true, id }, { status: 201 });
  } catch (error) {
    if (error?.status && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
    return handleRouteError(error, 'Could not queue the test print.');
  }
}
