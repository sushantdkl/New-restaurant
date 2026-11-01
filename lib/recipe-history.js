import { ensureColumn } from '@/lib/db/schema-helpers.js';
import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';

export async function ensureRecipeHistory(db) {
  await ensureColumn(db, 'recipes', 'version', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(db, 'recipes', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(db, 'recipe_items', 'loss_percent', 'NUMERIC(7,4) NOT NULL DEFAULT 0');
  await ensureSqliteTable(db, `CREATE TABLE IF NOT EXISTS recipe_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    version INTEGER NOT NULL, definition TEXT NOT NULL,
    effective_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(recipe_id, version))`);
}

export async function archiveRecipeVersion(db, id) {
  const recipe = await db.get('SELECT * FROM recipes WHERE id = ?', [id]);
  if (!recipe) return;
  const items = await db.all('SELECT * FROM recipe_items WHERE recipe_id = ? ORDER BY id', [id]);
  await db.run(`INSERT INTO recipe_versions (recipe_id, version, definition) VALUES (?, ?, ?)
    ON CONFLICT(recipe_id, version) DO NOTHING`, [id, recipe.version || 1, JSON.stringify({ ...recipe, items })]);
}
