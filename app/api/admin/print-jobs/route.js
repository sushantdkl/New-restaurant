import { NextResponse } from 'next/server';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { listPrintJobs, loadSettings } from '@/lib/print-jobs.js';

/**
 * Print helper queue status. `?ids=1,2` returns those jobs (the POS checks its
 * tickets actually printed); otherwise the latest jobs plus when the helper
 * last checked in, for Admin → Printer.
 */
export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'waiter', 'cashier', 'kitchen'] });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    const ids = (new URL(request.url).searchParams.get('ids') || '')
      .split(',').map((v) => parseInt(v, 10)).filter(Number.isFinite).slice(0, 50);
    const jobs = await listPrintJobs(db, { ids: ids.length ? ids : null });
    const settings = await loadSettings(db);
    const lastSeen = Number(settings.print_helper_last_seen || 0) || null;
    return NextResponse.json({ jobs, helper: { last_seen_ms: lastSeen, has_key: Boolean(settings.print_helper_key_hash) } });
  } catch (error) {
    return handleRouteError(error, 'Could not load print jobs.');
  }
}
