import { NextResponse } from 'next/server';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { reprintKot } from '@/lib/kot-service.js';
import { queueTicketPrints } from '@/lib/print-jobs.js';

/**
 * Reprint an existing KOT snapshot (marked REPRINT). Never creates a new KOT.
 * With the print helper on, the copy is queued for the ticket's own printer.
 */
export async function POST(request, context) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'waiter', 'cashier', 'kitchen'], permission: 'kots.reprint' });
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const kotId = parseInt(id, 10);
    if (!Number.isFinite(kotId)) return NextResponse.json({ error: 'Invalid KOT.' }, { status: 400 });

    const db = Database.getInstance();
    const { kot } = await reprintKot(db, { kotId, actor: auth.user });
    const print = await queueTicketPrints(db, { kots: [kot], reprint: true, actor: auth.user });
    return NextResponse.json({ success: true, kot, print });
  } catch (error) {
    return handleRouteError(error, 'Could not reprint the kitchen ticket.');
  }
}
