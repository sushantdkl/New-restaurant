import { accountBalance, currentDrawerId, primaryBankAccountId } from '@/lib/accounting.js';
import { BUSINESS_FUNDING_CODE, preparePaymentFunding } from '@/lib/business-funding.js';
import { businessDayIdForCalendarDate, currentBusinessDayId } from '@/lib/business-days.js';
import { normalizePaymentMethod } from '@/lib/payment-allocations.js';
import { nepalDateString } from '@/lib/report-dates.js';

const fail = (message, extra = {}) => { throw Object.assign(new Error(message), { status: 400, ...extra }); };
export function payrollMethod(value) {
  const method = normalizePaymentMethod(value || 'cash');
  if (!['cash', 'online', 'business_funding'].includes(method)) fail('Choose Cash, Online or Business Funding for this staff payment.');
  return method;
}

export function payrollDate(value = nepalDateString()) {
  const date = String(value);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('Choose a valid payment date.');
  if (date > nepalDateString()) fail('Staff payments cannot be dated in the future.');
  return date;
}

export async function payrollBusinessDay(db, date) {
  await currentBusinessDayId(db, { required: true });
  return businessDayIdForCalendarDate(db, date, { note: 'Historical day created for a late-entered staff payment.' });
}

/** Credits only the money actually leaving each source. No synthetic cash inflow. */
export async function payrollPayoutLines(tx, { amount, method, date, businessDayId, useBusinessFunding }) {
  if (!(amount > 0)) return [];
  const code = method === 'cash' ? '1010' : method === 'online' ? '1020' : BUSINESS_FUNDING_CODE;
  const funding = await preparePaymentFunding(tx, {
    amount, expense_date: date, business_day_id: businessDayId, use_business_funding: useBusinessFunding === true,
  }, code);
  if (code === BUSINESS_FUNDING_CODE) {
    const available = Number(await accountBalance(tx, BUSINESS_FUNDING_CODE));
    if (available + 0.001 < amount) fail(`Business Funding has Rs ${available.toFixed(2)} available, but Rs ${amount.toFixed(2)} is required.`,
      { status: 409, code: 'business_funding_insufficient', available, shortfall: Math.round((amount - available) * 100) / 100 });
  }
  const shortfall = Number(funding.amount || 0);
  const mediumAmount = Math.round((amount - shortfall) * 100) / 100;
  const historicalDrawer = code === '1010' ? await tx.get('SELECT drawer_id FROM drawer_sessions WHERE business_day_id = ? ORDER BY opened_at, id LIMIT 1', [businessDayId]) : null;
  return [
    ...(mediumAmount > 0 ? [{ code, debit: 0, credit: mediumAmount,
      drawer_id: code === '1010' ? historicalDrawer?.drawer_id || await currentDrawerId(tx) : null,
      bank_account_id: code === '1020' ? await primaryBankAccountId(tx) : null }] : []),
    ...(shortfall > 0 ? [{ code: BUSINESS_FUNDING_CODE, debit: 0, credit: shortfall, memo: 'Business Funding shortfall' }] : []),
  ];
}
