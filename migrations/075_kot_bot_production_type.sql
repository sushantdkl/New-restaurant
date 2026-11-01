-- KOT + BOT: kitchen and bar tickets inside the same order workflow.
--
-- Additive only. Nothing existing is rewritten or recalculated:
--   * every existing menu item reads as 'kot' (the column default), so current
--     restaurants keep printing kitchen tickets exactly as before;
--   * existing order lines keep production_type NULL, which every reader treats
--     as KOT, so historical tickets, bills and reports are not reclassified;
--   * existing tickets keep station = 'main', which is the kitchen station.
--
-- Production type is an operational routing label. It is not read by billing,
-- payment, stock or journal posting, so no financial record changes meaning.

-- Master setting per menu item: 'kot' (kitchen) or 'bot' (bar).
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS production_type TEXT DEFAULT 'kot';

-- Snapshot taken when a line is first sent on a ticket, so reclassifying a menu
-- item later never changes which ticket an already-sent line belonged to.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS production_type TEXT;

-- Tickets already carry `station` ('main' for every kitchen ticket). Bar tickets
-- use 'bar'. Index it for the kitchen/bar boards and reports.
CREATE INDEX IF NOT EXISTS idx_kots_station_status ON kots(station, status);
