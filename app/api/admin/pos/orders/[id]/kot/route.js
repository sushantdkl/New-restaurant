import { NextResponse } from 'next/server';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { issueKot, getOrderWorkspace } from '@/lib/kot-service.js';
import { queueTicketPrints } from '@/lib/print-jobs.js';

/**
 * Save & print KOT: persist new immutable tickets containing only the currently
 * unsent quantities — a kitchen KOT and/or a bar BOT, depending on the lines.
 * Idempotent on `idempotency_key` so a double-click / retry cannot create two
 * identical tickets. `kots` lists every ticket; `kot` is the first of them.
 * Optional `production_type` ('kot' | 'bot') sends only that station's lines.
 */
export async function POST(request, context) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'waiter', 'cashier'], permission: 'kots.create' });
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const orderId = parseInt(id, 10);
    if (!Number.isFinite(orderId)) return NextResponse.json({ error: 'Invalid order.' }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const idempotencyKey = String(body.idempotency_key || '').trim().slice(0, 100) || null;

    const db = Database.getInstance();
    const { kot, kots, idempotent } = await issueKot(db, {
      orderId,
      actor: auth.user,
      idempotencyKey,
      orderNotes: body.order_notes ?? null,
      productionType: ['kot', 'bot'].includes(body.production_type) ? body.production_type : null,
    });

    // With the print helper on, `print: true` queues each ticket for its own
    // printer (kitchen / bar); otherwise `print.mode` is 'browser' and the
    // client prints as before. Queuing is once per ticket, so a retry is safe.
    const print = body.print === true
      ? await queueTicketPrints(db, { kots: kots || (kot ? [kot] : []), actor: auth.user })
      : null;
    const workspace = await getOrderWorkspace(db, orderId);
    return NextResponse.json({ success: true, idempotent: !!idempotent, kot, kots, print, workspace }, { status: idempotent ? 200 : 201 });
  } catch (error) {
    if (error?.status && error.status < 500) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return handleRouteError(error, 'Could not save the kitchen ticket.');
  }
}
