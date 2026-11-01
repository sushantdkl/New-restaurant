/**
 * KOT / BOT production types.
 *
 * Every menu item is prepared either in the kitchen (KOT) or at the bar (BOT).
 * This is an operational routing label only: it decides which ticket an item
 * is printed on and lets screens filter by station. It never changes prices,
 * tax, billing, stock or accounting — a BOT line is billed, paid, consumed and
 * posted exactly like a KOT line.
 *
 *   menu_items.production_type   the master setting ('kot' default, or 'bot')
 *   order_items.production_type  snapshot taken when the line is first sent on a
 *                                ticket, so reclassifying an item later never
 *                                rewrites history. NULL = not yet sent.
 *   kots.station                 'main' for kitchen tickets (the value every
 *                                existing ticket already carries) or 'bar'.
 *
 * Anything missing or unrecognised is KOT, so existing data behaves as before.
 */

import { ensureColumn } from '@/lib/db/schema-helpers.js';

export const PRODUCTION_TYPES = ['kot', 'bot'];

export const PRODUCTION_LABELS = {
  kot: { short: 'KOT', station: 'Kitchen', ticket: 'KITCHEN ORDER TICKET' },
  bot: { short: 'BOT', station: 'Bar', ticket: 'BAR ORDER TICKET' },
};

/** 'bot' only when explicitly BOT; everything else is the legacy kitchen default. */
export function normalizeProductionType(value) {
  return String(value || '').trim().toLowerCase() === 'bot' ? 'bot' : 'kot';
}

/** kots.station value for a production type. Kitchen keeps the legacy 'main'. */
export function stationForProductionType(type) {
  return normalizeProductionType(type) === 'bot' ? 'bar' : 'main';
}

/** Production type of a ticket row, from its station. */
export function productionTypeForTicket(ticket) {
  return String(ticket?.station || '').toLowerCase() === 'bar' ? 'bot' : 'kot';
}

/**
 * SQL for an order line's effective type: its snapshot once sent, otherwise the
 * menu item's current setting. Callers alias order_items `oi` and menu_items `mi`.
 */
export const LINE_PRODUCTION_TYPE_SQL =
  `LOWER(COALESCE(NULLIF(oi.production_type, ''), NULLIF(mi.production_type, ''), 'kot'))`;

/**
 * SQL for the type a SOLD line is reported under (alias `oi`). Never reads the
 * menu's current setting, so reclassifying an item cannot rewrite past sales:
 *   1. the snapshot stamped when the line was sent;
 *   2. lines sent before KOT/BOT existed: the station of the ticket that
 *      actually carried them (every such ticket was a kitchen ticket);
 *   3. never on any ticket and no snapshot: 'other' — shown as its own
 *      reconciliation bucket instead of being guessed.
 */
export const SOLD_LINE_TYPE_SQL = `CASE
    WHEN LOWER(COALESCE(oi.production_type, '')) IN ('kot', 'bot') THEN LOWER(oi.production_type)
    WHEN EXISTS (SELECT 1 FROM kot_items ki_t JOIN kots k_t ON k_t.id = ki_t.kot_id
                 WHERE ki_t.order_item_id = oi.id AND COALESCE(k_t.station, 'main') = 'bar') THEN 'bot'
    WHEN EXISTS (SELECT 1 FROM kot_items ki_t WHERE ki_t.order_item_id = oi.id) THEN 'kot'
    ELSE 'other' END`;

/** Report labels, including the reconciliation bucket. */
export const REPORT_TYPE_LABELS = { kot: 'Kitchen (KOT)', bot: 'Bar (BOT)', other: 'Other / unclassified' };

/** 'kot' | 'bot' from a report filter value, or null for ALL. */
export function productionFilterValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'kot' || v === 'bot' ? v : null;
}

/**
 * Settings switch: when 'true', every item — kitchen and bar alike — goes on
 * one kitchen ticket (KOT), the flow used before BOT existed. Off (default),
 * bar items get their own BOT. Routing only: billing never reads it.
 */
export const COMBINE_TICKETS_SETTING = 'combine_kot_bot_tickets';

export function combinedTicketsOn(settings) {
  return String(settings?.[COMBINE_TICKETS_SETTING] ?? 'false') === 'true';
}

/** Reads the switch; any failure means the default (separate KOT and BOT). */
export async function loadCombinedTickets(db) {
  const row = await db.get(
    'SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1',
    [COMBINE_TICKETS_SETTING]
  ).catch(() => null);
  return combinedTicketsOn({ [COMBINE_TICKETS_SETTING]: row?.setting_value });
}

let schemaReady = false;

/** Additive columns; soft on hosts where the app user cannot ALTER (see migration 075). */
export async function ensureProductionTypeSchema(db) {
  if (schemaReady && db.driver !== 'sqlite') return;
  await ensureColumn(db, 'menu_items', 'production_type', "TEXT DEFAULT 'kot'");
  await ensureColumn(db, 'order_items', 'production_type', 'TEXT');
  // Reports resolve pre-KOT/BOT lines through the ticket that carried them.
  await db.run('CREATE INDEX IF NOT EXISTS idx_kot_items_order_item ON kot_items(order_item_id)').catch(() => {});
  schemaReady = true;
}
