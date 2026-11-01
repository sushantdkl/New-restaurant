import { createHash } from 'node:crypto';
import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';

export async function ensureInventoryOperations(db) {
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS inventory_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT NOT NULL UNIQUE,
    order_id INTEGER REFERENCES orders(id) ON DELETE RESTRICT,
    operation_type TEXT NOT NULL CHECK(operation_type IN ('deduct','restore')),
    payload_hash TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}

/** Caller owns the transaction, including the order mutation and these receipts. */
export async function inventoryOperation(db, items, context, type, apply) {
  const key = context.operationKey;
  // Serialize same-order deductions, restorations and retry receipts.
  if (context.orderId && db.driver === 'postgres') await db.get('SELECT id FROM orders WHERE id = ? FOR UPDATE', [context.orderId]);
  if (!key) return apply();
  const canonical = items.map((item) => ({ menu: item.menu_item_id || item.item_id || item.id || null,
    variant: item.variant_name || '', quantity: Number(item.quantity), combo: item.combo_snapshot || null,
    name: item.item_name || item.name || '', price: item.price ?? null, notes: item.special_instructions || '' }));
  const hash = createHash('sha256').update(JSON.stringify({ order: context.orderId, type, items: canonical })).digest('hex');
  const existing = await db.get('SELECT * FROM inventory_operations WHERE operation_key = ?', [key]);
  if (existing) {
    if (existing.payload_hash !== hash || existing.operation_type !== type) throw Object.assign(new Error('Inventory retry key was already used for different items.'), { status: 409 });
    return { ...JSON.parse(existing.result_json), replayed: true };
  }
  await db.run('INSERT INTO inventory_operations(operation_key,order_id,operation_type,payload_hash) VALUES (?,?,?,?)', [key, context.orderId || null, type, hash]);
  const result = await apply();
  await db.run('UPDATE inventory_operations SET result_json = ? WHERE operation_key = ?', [JSON.stringify(result), key]);
  return result;
}
