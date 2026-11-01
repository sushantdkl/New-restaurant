import { NextResponse } from 'next/server';
import Database from '@/lib/db/index.js';
import { requireAuth, handleRouteError } from '@/lib/api-guard.js';
import { listRolePermissions, setRolePermissions, permissionAuditHistory } from '@/lib/permissions.js';

export async function GET(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin'] });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    const view = new URL(request.url).searchParams.get('view');
    const matrix = await listRolePermissions(db);
    if (view === 'audit') {
      return NextResponse.json({ ...matrix, audit: await permissionAuditHistory(db) });
    }
    return NextResponse.json(matrix);
  } catch (error) {
    return handleRouteError(error, 'Could not load the permission matrix.');
  }
}

export async function PUT(request) {
  try {
    const auth = await requireAuth(request, { roles: ['admin'] });
    if (auth.error) return auth.error;
    const db = Database.getInstance();
    const body = await request.json();
    const matrix = await setRolePermissions(db, body.updates, auth.user);
    return NextResponse.json({ message: 'Permissions updated.', ...matrix });
  } catch (error) {
    return handleRouteError(error, 'Could not save permission changes.');
  }
}
