import { NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { finishPrintJob, verifyHelperKey } from '@/lib/print-jobs.js';

/** Print helper reports one job as printed (`ok: true`) or failed. */
export async function POST(request, context) {
  try {
    const db = Database.getInstance();
    if (!await verifyHelperKey(db, request)) {
      return NextResponse.json({ error: 'Invalid print helper key.' }, { status: 401 });
    }
    const { id } = await context.params;
    const jobId = parseInt(id, 10);
    if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'Invalid print job.' }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const result = await finishPrintJob(db, { id: jobId, ok: body.ok === true, error: body.error });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return handleRouteError(error, 'Could not update the print job.');
  }
}
