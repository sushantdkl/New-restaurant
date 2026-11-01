import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PosDatabase } from '../../lib/db/index.js';
import { currentBusinessDay, openBusinessDay } from '../../lib/business-days.js';
import { createSavingsDeposit, voidSavingsDeposit } from '../../lib/savings.js';

const actor = { id: 1, full_name: 'Admin', role: 'admin' };
const file = path.join(os.tmpdir(), `savings-backdate-${process.pid}-${Date.now()}.db`);
const db = new PosDatabase(file);
test.after(() => { try { db.db.close(); } catch { /* ignore */ } fs.rmSync(file, { force: true }); });

test('a backdated savings deposit takes money out of its own date, not today', async () => {
  await openBusinessDay(db, { opening_cash: 5000 }, actor);
  const today = await currentBusinessDay(db);
  const base = { destination_name: 'Sahakari', source_account: 'cash', amount: 500 };
  const journalOf = (row) => db.get(`SELECT entry_date,business_day_id FROM journal_entries WHERE id=?`, [row.journal_id]);

  const old = await createSavingsDeposit(db, { ...base, deposit_date: '2020-01-05' }, actor.id);
  const oldJournal = await journalOf(old);
  assert.equal(String(oldJournal.entry_date).slice(0, 10), '2020-01-05');
  assert.notEqual(Number(oldJournal.business_day_id), Number(today.id));
  const oldDay = await db.get(`SELECT business_date FROM business_days WHERE id=?`, [oldJournal.business_day_id]);
  assert.equal(String(oldDay.business_date).slice(0, 10), '2020-01-05');

  const now = await createSavingsDeposit(db, base, actor.id);
  assert.equal(Number((await journalOf(now)).business_day_id), Number(today.id));

  // Voiding it later reverses on that same old day, not today.
  await voidSavingsDeposit(db, old.id, 'entered twice', actor.id);
  const voidJournal = await db.get(`SELECT entry_date,business_day_id FROM journal_entries WHERE source_type='savings_deposit_void' AND source_id=?`, [old.id]);
  assert.equal(String(voidJournal.entry_date).slice(0, 10), '2020-01-05');
  assert.equal(Number(voidJournal.business_day_id), Number(oldJournal.business_day_id));

  await assert.rejects(createSavingsDeposit(db, { ...base, deposit_date: '2999-01-01' }, actor.id), /future/);
});
