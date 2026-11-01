-- KOT/BOT reporting: a sold line's type is resolved from its own snapshot, or
-- for lines sent before KOT/BOT existed, from the ticket that carried it. This
-- index keeps that lookup cheap. Additive only; no data changes.
CREATE INDEX IF NOT EXISTS idx_kot_items_order_item ON kot_items(order_item_id);
