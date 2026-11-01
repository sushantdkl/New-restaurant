import { NextResponse } from 'next/server';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import Database from '@/lib/db/index.js';
import { createHelperKey } from '@/lib/print-jobs.js';

/**
 * Create a new print helper key (replacing any previous one). The key is
 * returned once; only its hash is stored, so a lost key is replaced, not shown.
 */
export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin'] });
    if (auth.error) return auth.error;
    const key = await createHelperKey(Database.getInstance());
    return NextResponse.json({ success: true, key }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, 'Could not create the print helper key.');
  }
}
