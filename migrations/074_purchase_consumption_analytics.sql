-- Additive only. No historical movements or journals are manufactured.
ALTER TABLE inventory_categories ADD COLUMN IF NOT EXISTS food_group TEXT;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recipe_items ADD COLUMN IF NOT EXISTS loss_percent NUMERIC(7,4) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS recipe_versions (
  id SERIAL PRIMARY KEY,
  recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  effective_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recipe_id, version)
);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sale_menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sale_variant TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS consumption_key TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sold_quantity NUMERIC(18,6);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS recipe_snapshot TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS cost_status TEXT;
CREATE INDEX IF NOT EXISTS idx_stock_sale_attribution ON stock_movements(reference_id, sale_menu_item_id, sale_variant, change_type);
CREATE INDEX IF NOT EXISTS idx_stock_consumption_key ON stock_movements(consumption_key);
-- Purchases inherit their business day from the existing linked expense.
CREATE INDEX IF NOT EXISTS idx_purchase_analytics_scope ON purchases(created_at, status);
CREATE INDEX IF NOT EXISTS idx_stock_analytics_scope ON stock_movements(business_day_id, created_at, change_type);
-- A durable receipt is required even for unmapped sales with no movement lines.
CREATE TABLE IF NOT EXISTS inventory_operations (
  id SERIAL PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE RESTRICT,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('deduct', 'restore')),
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
