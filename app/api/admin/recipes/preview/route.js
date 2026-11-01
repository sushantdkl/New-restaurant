import { NextResponse } from 'next/server';
import Database from '@/lib/db/index.js';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { ensureRecipeTables, previewRecipe } from '@/lib/recipes.js';

export async function POST(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin', 'cashier'], permission: 'menu.manage' });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    await ensureRecipeTables(db);
    return NextResponse.json({ cost: await previewRecipe(db, await request.json()) });
  } catch (error) { return handleRouteError(error, 'Could not preview recipe cost.'); }
}
