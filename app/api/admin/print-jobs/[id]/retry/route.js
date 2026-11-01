import { NextResponse } from 'next/server';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { retryPrintJob } from '@/lib/print-jobs.js';

/** Send a failed or stuck print job to the print helper again. */
export async function POST(request, context) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier', 'waiter', 'kitchen'], permission: 'kots.reprint' });
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const jobId = parseInt(id, 10);
    if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'Invalid print job.' }, { status: 400 });
    await retryPrintJob(Database.getInstance(), jobId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, 'Could not retry the print job.');
  }
}
