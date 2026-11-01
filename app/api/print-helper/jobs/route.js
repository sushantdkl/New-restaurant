import { NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { claimPrintJobs, verifyHelperKey } from '@/lib/print-jobs.js';

/**
 * Print helper poll: claims due kitchen/bar print jobs with the printer each
 * goes to. Authenticated by the helper key (Admin → Printer), not a session.
 */
export async function GET(request) {
  try {
    const db = Database.getInstance();
    if (!await verifyHelperKey(db, request)) {
      return NextResponse.json({ error: 'Invalid print helper key.' }, { status: 401 });
    }
    return NextResponse.json(await claimPrintJobs(db), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return handleRouteError(error, 'Could not load print jobs.');
  }
}
