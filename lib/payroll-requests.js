import { createHash } from 'node:crypto';

const TABLES = new Set(['salary_advances', 'salary_payments', 'staff_salary_adjustments']);
const fail = (message) => { throw Object.assign(new Error(message), { status: 409, code: 'payroll_request_conflict' }); };

/** Retain request receipts independently of payroll rows, including after deletion. */
export async function beginPayrollRequest(tx, key, table, payload, actorId) {
  if (!TABLES.has(table)) throw new Error('Invalid payroll request source.');
  if (key == null || key === '') return { key: null };
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) {
    throw Object.assign(new Error('Invalid payroll request key. Refresh and try again.'), { status: 400 });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([table, actorId, payload])).digest('hex');
  if (tx.driver === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(hashtext(?))', [`payroll:${key}`]);
  const receipt = await tx.get('SELECT * FROM payroll_requests WHERE request_key = ?', [key]);
  if (!receipt) return { key, fingerprint };
  if (receipt.fingerprint !== fingerprint || receipt.source_table !== table) fail('This request was already saved with different details. Refresh the history before recording another entry.');
  const row = await tx.get(`SELECT * FROM ${table} WHERE id = ?`, [receipt.source_id]);
  if (!row) fail('This payroll entry was removed. Start a new entry to record another payment.');
  return { key, fingerprint, replay: row };
}

export async function finishPayrollRequest(tx, request, table, sourceId) {
  if (!request.key) return;
  await tx.run('INSERT INTO payroll_requests (request_key, fingerprint, source_table, source_id) VALUES (?, ?, ?, ?)',
    [request.key, request.fingerprint, table, sourceId]);
}
