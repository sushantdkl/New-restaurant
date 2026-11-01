/**
 * Kitchen (KOT) / Bar (BOT) attribution of sales — one shared calculation for
 * every dashboard, summary and report that shows the split.
 *
 * Nothing here computes a sales figure of its own. Each caller passes the bill
 * scope it ALREADY uses for its headline total (business day, report filters,
 * analytics period), and every amount the bill carries — grand total,
 * discount, VAT, service charge, delivery fee, later refunds — is divided
 * across that bill's own sold lines in proportion to their line value:
 *
 *   KOT + BOT + Other = the caller's own total, to the paisa
 *
 * Allocation is in integer paisa with a largest-remainder rule per bill, so
 * rounding never leaks. A line's type is the snapshot persisted on the order
 * line (SOLD_LINE_TYPE_SQL); today's menu setting is never read. Delivery fees,
 * bills with no sold lines, and lines that were never classified go to Other
 * rather than being guessed. Refunds are bill-level records, so a refund is
 * split by the mix of the bill it refunds — never by today's classification.
 *
 * Read-only: no records are written and no posting rule is involved.
 */

import { SOLD_LINE_TYPE_SQL, REPORT_TYPE_LABELS } from '@/lib/production-type.js';

export const REPORT_TYPES = ['kot', 'bot', 'other'];

/**
 * A sold line's value after its bill's discount (spread pro rata over the
 * bill's lines). Shared with lib/reports.js (LINE_REVENUE) so item, category
 * and KOT/BOT item tables use one definition. Aliases `oi` and `b`.
 */
export const NET_LINE_VALUE_SQL = `COALESCE(oi.subtotal, oi.quantity * COALESCE(oi.price, 0)) *
             CASE WHEN COALESCE(b.subtotal,0) > 0
               THEN CASE WHEN COALESCE(b.discount_amount,0) >= b.subtotal THEN 0
                         ELSE (b.subtotal-COALESCE(b.discount_amount,0))/b.subtotal END
               ELSE 1 END`;

const LINE_BASE_SQL = 'COALESCE(oi.subtotal, oi.quantity * COALESCE(oi.price, 0))';
const LIVE_LINE_SQL = "COALESCE(oi.status, '') NOT IN ('voided', 'cancelled')";
const BILL_TAX_SQL = 'CASE WHEN COALESCE(b.vat_amount, 0) <> 0 THEN b.vat_amount ELSE COALESCE(b.tax, 0) END';

const cents = (value) => Math.round(Number(value || 0) * 100);
const rupees = (paisa) => Math.round(paisa) / 100;

/**
 * Split `total` paisa over `weights` with the largest-remainder rule: the parts
 * are whole paisa and always sum to exactly `total`. Null when no weight.
 */
export function allocateCents(total, weights) {
  const sum = weights.reduce((s, w) => s + Math.max(0, Number(w) || 0), 0);
  if (!(sum > 0)) return null;
  const sign = total < 0 ? -1 : 1;
  const whole = Math.abs(Math.round(total));
  const exact = weights.map((w) => (Math.max(0, Number(w) || 0) / sum) * whole);
  const parts = exact.map(Math.floor);
  let left = whole - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) parts[order[k][1]] += 1;
  return parts.map((p) => p * sign);
}

function emptyBucket() {
  return {
    quantity: 0, bills: 0, complimentary_qty: 0,
    item_sales: 0, gross: 0, discount: 0, tax: 0, service_charge: 0, delivery_fee: 0,
    sales: 0, refunds: 0, net_sales: 0,
  };
}

function emptyGroup() {
  return Object.fromEntries(REPORT_TYPES.map((t) => [t, emptyBucket()]));
}

async function lineMix(db, sql, params) {
  // One row per bill and type: the bill's sold line value and quantity.
  return db.all(
    `SELECT x.bill_id, x.production_type, SUM(x.base) AS base, SUM(x.quantity) AS quantity
     FROM (
       SELECT b.id AS bill_id, ${SOLD_LINE_TYPE_SQL} AS production_type,
              ${LINE_BASE_SQL} AS base, oi.quantity AS quantity
       FROM bills b JOIN orders o ON b.order_id = o.id
       JOIN order_items oi ON oi.order_id = o.id
       ${sql} AND ${LIVE_LINE_SQL}
     ) x
     GROUP BY x.bill_id, x.production_type`,
    params
  );
}

function weightsFor(mix) {
  return REPORT_TYPES.map((t) => Math.max(0, Number(mix?.[t]?.base || 0)));
}

/**
 * @param {object} db
 * @param {object} opts
 *   bills:   { sql, params } — the caller's own bill scope; `sql` starts with
 *            ' WHERE' and may use aliases `b` (bills) and `o` (orders).
 *   refunds: { sql, params } | null — the caller's own refund scope, a
 *            condition on bill_corrections aliased `bc`.
 *   bucket:  SQL on `b`/`o` to group by (date, waiter…), optional.
 *   refundBucket: SQL on `bc` giving the same buckets for refunds, optional.
 *   bucketKey: normalises a bucket value into a map key (e.g. dates).
 * @returns {{ rows, total, buckets }}
 */
export async function productionSales(db, { bills, refunds = null, bucket = null, refundBucket = null, bucketKey = String }) {
  const [billRows, mixRows, refundRows] = await Promise.all([
    db.all(
      `SELECT b.id AS bill_id, ${bucket ? `${bucket}` : 'NULL'} AS grp,
              b.grand_total, COALESCE(b.discount_amount, 0) AS discount, ${BILL_TAX_SQL} AS tax,
              COALESCE(b.service_charge, 0) AS service_charge, COALESCE(b.delivery_fee, 0) AS delivery_fee,
              COALESCE(b.subtotal, 0) AS subtotal
       FROM bills b LEFT JOIN orders o ON b.order_id = o.id
       ${bills.sql}`,
      bills.params
    ),
    lineMix(db, bills.sql, bills.params),
    refunds
      ? db.all(
        `SELECT bc.bill_id, ${refundBucket || 'NULL'} AS grp,
                SUM(CASE WHEN bc.type = 'refund' THEN bc.amount WHEN bc.type = 'refund_reversal' THEN -bc.amount ELSE 0 END) AS amount
         FROM bill_corrections bc
         WHERE bc.type IN ('refund', 'refund_reversal') AND ${refunds.sql}
         GROUP BY bc.bill_id${refundBucket ? `, ${refundBucket}` : ''}`,
        refunds.params
      )
      : [],
  ]);

  const mixByBill = new Map();
  const addMix = (row) => {
    const entry = mixByBill.get(Number(row.bill_id)) || {};
    entry[row.production_type] = { base: Number(row.base || 0), quantity: Number(row.quantity || 0) };
    mixByBill.set(Number(row.bill_id), entry);
  };
  (mixRows || []).forEach(addMix);

  // A refund may be for a bill outside the sales scope (refunded today, sold
  // yesterday); its split still comes from that original bill's lines.
  const missing = [...new Set((refundRows || []).map((r) => Number(r.bill_id)).filter((id) => !mixByBill.has(id)))];
  if (missing.length) {
    const marks = missing.map(() => '?').join(', ');
    (await lineMix(db, ` WHERE b.id IN (${marks})`, missing) || []).forEach(addMix);
  }

  const total = emptyGroup();
  const buckets = new Map();
  const groupFor = (key) => {
    if (key == null) return null;
    const k = bucketKey(key);
    if (!buckets.has(k)) buckets.set(k, emptyGroup());
    return buckets.get(k);
  };
  const addCents = (groups, type, field, paisa) => {
    for (const g of groups) if (g) g[type][field] += paisa;
  };

  for (const bill of billRows || []) {
    const groups = [total, groupFor(bill.grp)];
    const mix = mixByBill.get(Number(bill.bill_id)) || {};
    const weights = weightsFor(mix);
    const gt = cents(bill.grand_total);
    const discount = cents(bill.discount);
    const delivery = cents(bill.delivery_fee);
    const split = (amount) => allocateCents(amount, weights) || [0, 0, amount];

    const gross = split(gt + discount - delivery);
    const disc = split(discount);
    const tax = split(cents(bill.tax));
    const service = split(cents(bill.service_charge));
    const items = split(cents(bill.subtotal));
    REPORT_TYPES.forEach((type, i) => {
      addCents(groups, type, 'gross', gross[i] + (type === 'other' ? delivery : 0));
      addCents(groups, type, 'discount', disc[i]);
      addCents(groups, type, 'tax', tax[i]);
      addCents(groups, type, 'service_charge', service[i]);
      addCents(groups, type, 'item_sales', items[i]);
      if (type === 'other') addCents(groups, type, 'delivery_fee', delivery);
      const quantity = mix[type]?.quantity || 0;
      if (quantity || (type === 'other' && !weights.some(Boolean))) {
        for (const g of groups) if (g) { g[type].quantity += quantity; g[type].bills += 1; }
      }
      // A Rs 0 settled bill is complimentary: consumption, not revenue.
      if (gt === 0 && quantity) for (const g of groups) if (g) g[type].complimentary_qty += quantity;
    });
  }

  for (const refund of refundRows || []) {
    const groups = [total, groupFor(refund.grp)];
    const weights = weightsFor(mixByBill.get(Number(refund.bill_id)));
    const amount = cents(refund.amount);
    const parts = allocateCents(amount, weights) || [0, 0, amount];
    REPORT_TYPES.forEach((type, i) => addCents(groups, type, 'refunds', parts[i]));
  }

  const finish = (group) => {
    const rows = REPORT_TYPES.map((type) => {
      const r = group[type];
      const sales = r.gross - r.discount; // = this type's share of grand totals
      return {
        production_type: type,
        label: REPORT_TYPE_LABELS[type],
        quantity: r.quantity,
        bills: r.bills,
        complimentary_qty: r.complimentary_qty,
        item_sales: rupees(r.item_sales),
        gross: rupees(r.gross),
        discount: rupees(r.discount),
        tax: rupees(r.tax),
        service_charge: rupees(r.service_charge),
        delivery_fee: rupees(r.delivery_fee),
        sales: rupees(sales),
        refunds: rupees(r.refunds),
        net_sales: rupees(sales - r.refunds),
        net_excl_tax: rupees(sales - r.tax - r.refunds),
      };
    });
    const sum = (key) => rupees(rows.reduce((s, r) => s + cents(r[key]), 0));
    const totalRow = {
      production_type: 'total', label: 'Total',
      quantity: rows.reduce((s, r) => s + r.quantity, 0),
      complimentary_qty: rows.reduce((s, r) => s + r.complimentary_qty, 0),
      ...Object.fromEntries(['item_sales', 'gross', 'discount', 'tax', 'service_charge', 'delivery_fee', 'sales', 'refunds', 'net_sales', 'net_excl_tax'].map((k) => [k, sum(k)])),
    };
    for (const r of rows) r.share = totalRow.net_sales ? Math.round((r.net_sales / totalRow.net_sales) * 1000) / 10 : 0;
    return { rows, total: totalRow };
  };

  const result = finish(total);
  return {
    ...result,
    // Whether anything was ever classified BOT in this scope — screens hide the
    // breakdown for kitchen-only restaurants.
    hasBar: result.rows.some((r) => r.production_type === 'bot' && (r.quantity || r.net_sales)),
    buckets: new Map([...buckets.entries()].map(([k, g]) => [k, finish(g)])),
  };
}

/**
 * Best sellers per type (kitchen / bar), valued exactly like the Menu report
 * (NET_LINE_VALUE_SQL), within the caller's bill scope.
 */
export async function topItemsByProduction(db, { bills, limit = 5 }) {
  const rows = await db.all(
    `SELECT x.production_type, x.name, SUM(x.quantity) AS quantity, SUM(x.revenue) AS revenue
     FROM (
       SELECT ${SOLD_LINE_TYPE_SQL} AS production_type,
              COALESCE(oi.item_name, mi.name, 'Item') AS name,
              oi.quantity AS quantity, ${NET_LINE_VALUE_SQL} AS revenue
       FROM bills b JOIN orders o ON b.order_id = o.id
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN menu_items mi ON COALESCE(oi.menu_item_id, oi.item_id) = mi.id
       ${bills.sql} AND ${LIVE_LINE_SQL}
     ) x
     WHERE x.production_type IN ('kot', 'bot')
     GROUP BY x.production_type, x.name`,
    bills.params
  );
  const pick = (type) => (rows || [])
    .filter((r) => r.production_type === type)
    .map((r) => ({ name: r.name, quantity: Number(r.quantity || 0), revenue: Math.round(Number(r.revenue || 0) * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity)
    .slice(0, limit);
  return { kot: pick('kot'), bot: pick('bot') };
}

/** Cancelled kitchen / bar quantities and ticket counts (production, not money). */
export async function productionTickets(db, { sql, params }) {
  const station = `CASE WHEN COALESCE(k.station, 'main') = 'bar' THEN 'bot' ELSE 'kot' END`;
  const rows = await db.all(
    `SELECT ${station} AS production_type,
            SUM(CASE WHEN COALESCE(k.kot_type, 'new') <> 'cancellation' AND COALESCE(k.voided, 0) = 0 THEN 1 ELSE 0 END) AS tickets,
            SUM(CASE WHEN COALESCE(k.kot_type, 'new') = 'cancellation' THEN 1 ELSE 0 END) AS cancellation_tickets,
            SUM(CASE WHEN COALESCE(k.kot_type, 'new') = 'cancellation' THEN
                  (SELECT COALESCE(SUM(ki.quantity), 0) FROM kot_items ki WHERE ki.kot_id = k.id AND COALESCE(ki.is_cancellation, 0) = 1)
                ELSE 0 END) AS cancelled_qty
     FROM kots k WHERE ${sql}
     GROUP BY ${station}`,
    params
  );
  const by = Object.fromEntries((rows || []).map((r) => [r.production_type, r]));
  return Object.fromEntries(['kot', 'bot'].map((t) => [t, {
    tickets: Number(by[t]?.tickets || 0),
    cancellation_tickets: Number(by[t]?.cancellation_tickets || 0),
    cancelled_qty: Number(by[t]?.cancelled_qty || 0),
  }]));
}
