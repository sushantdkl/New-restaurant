import { foodGroupSql } from '@/lib/food-groups.js';

/** Last-resort defaults for inventory with no explicit menu/recipe connections. */
export const INVENTORY_MASTER_DEFAULTS = {
  beverage: ['beverage', 'beverages', 'baverages', 'tea/beverage', 'alcohol', 'liquor', 'spirits'],
  food: ['food', 'dairy products', 'grocery / raw materials', 'grocery / raw materialspc', 'meat/fish', 'vegetables/fruits', 'vegatables/fruits'],
  tobacco: ['tobacco', 'tobacco items'],
  other: ['cleaning supplies', 'maintenance', 'other / miscellaneous', 'packaging materials', 'plastic and kitchen items'],
};

const aliases = { beverages: 'beverage', liquor: 'beverage', alcohol: 'beverage', alcoholic: 'beverage', foods: 'food', uncategorized: 'uncategorised' };
const clean = (value) => String(value || '').trim().toLowerCase();
export function inventoryMaster(category) {
  const saved = clean(category?.food_group);
  if (saved) return aliases[saved] || (Object.hasOwn(INVENTORY_MASTER_DEFAULTS, saved) ? saved : 'uncategorised');
  return Object.entries(INVENTORY_MASTER_DEFAULTS).find(([, names]) => names.includes(clean(category?.name)))?.[0] || 'uncategorised';
}

export function inventoryMasterSql(alias = 'ic') {
  const saved = `LOWER(TRIM(COALESCE(${alias}.food_group, '')))`;
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  return `CASE
    WHEN ${alias}.id IS NULL THEN 'uncategorised'
    ${Object.entries(aliases).map(([from, to]) => `WHEN ${saved} = ${quote(from)} THEN ${quote(to)}`).join('\n')}
    WHEN ${saved} IN (${Object.keys(INVENTORY_MASTER_DEFAULTS).map(quote).join(',')}) THEN ${saved}
    WHEN ${saved} <> '' THEN 'uncategorised'
    ${Object.entries(INVENTORY_MASTER_DEFAULTS).map(([master, names]) => `WHEN LOWER(TRIM(${alias}.name)) IN (${names.map(quote).join(',')}) THEN ${quote(master)}`).join('\n')}
    ELSE 'uncategorised' END`;
}

/**
 * One classification per inventory item, so a shared ingredient never multiplies
 * purchase lines or stock values. UNION terminates even for legacy recipe cycles.
 * Direct stock links override a menu's base recipe, matching stock consumption.
 * Variant links are additional valid paths; we never infer links from item names.
 */
export function inventoryMasterCtes() {
  const menuMaster = foodGroupSql('link_mc');
  const fallback = inventoryMasterSql('category');
  const assigned = "TRIM(COALESCE(category.food_group, '')) <> ''";
  return `WITH RECURSIVE menu_recipe_tree(menu_item_id, recipe_id) AS (
    SELECT r.menu_item_id, r.id FROM recipes r
    WHERE r.type = 'menu_item' AND r.menu_item_id IS NOT NULL AND COALESCE(r.is_active, 1) = 1
      AND NOT EXISTS (SELECT 1 FROM inventory_items direct
        WHERE direct.menu_item_id = r.menu_item_id AND COALESCE(direct.is_archived, 0) = 0)
    UNION
    SELECT tree.menu_item_id, child.id FROM menu_recipe_tree tree
      JOIN recipe_items line ON line.recipe_id = tree.recipe_id AND line.quantity > 0
      JOIN recipes child ON child.id = line.component_recipe_id AND COALESCE(child.is_active, 1) = 1
  ), inventory_menu_links AS (
    SELECT item.id AS inventory_item_id, item.menu_item_id FROM inventory_items item
      WHERE item.menu_item_id IS NOT NULL AND COALESCE(item.is_archived, 0) = 0
    UNION
    SELECT variant.inventory_item_id, variant.menu_item_id FROM menu_item_variants variant
      WHERE variant.inventory_item_id IS NOT NULL
    UNION
    SELECT line.raw_material_id, tree.menu_item_id FROM menu_recipe_tree tree
      JOIN recipe_items line ON line.recipe_id = tree.recipe_id
      WHERE line.raw_material_id IS NOT NULL AND line.quantity > 0
  ), inventory_link_masters AS (
    SELECT link.inventory_item_id, COUNT(DISTINCT ${menuMaster}) AS master_count,
      MIN(${menuMaster}) AS linked_master
    FROM inventory_menu_links link JOIN menu_items link_mi ON link_mi.id = link.menu_item_id
      LEFT JOIN menu_categories link_mc ON link_mc.id = link_mi.category_id
    GROUP BY link.inventory_item_id
  ), inventory_masters AS (
    SELECT item.id AS inventory_item_id,
      CASE WHEN ${assigned} THEN ${fallback}
        WHEN links.master_count > 1 THEN 'uncategorised'
        WHEN links.master_count = 1 THEN links.linked_master
        ELSE ${fallback} END AS master,
      CASE WHEN ${assigned} THEN 'Inventory assignment'
        WHEN links.master_count > 1 THEN 'Shared across menu categories'
        WHEN links.master_count = 1 AND links.linked_master = 'uncategorised' THEN 'Linked menu category missing'
        WHEN links.master_count = 1 THEN 'Linked menu items / recipes'
        WHEN ${fallback} <> 'uncategorised' THEN 'Category name fallback'
        ELSE 'Unlinked / unmapped' END AS mapping_source,
      CASE WHEN NOT (${assigned}) AND links.master_count > 1 THEN 1 ELSE 0 END AS mapping_conflicts
    FROM inventory_items item LEFT JOIN inventory_categories category ON category.id = item.category_id
      LEFT JOIN inventory_link_masters links ON links.inventory_item_id = item.id
  )`;
}

/** Category pickers can contain items belonging to several effective masters. */
export async function inventoryCategoryMasters(db) {
  const rows = await db.all(`${inventoryMasterCtes()}
    SELECT category.id, category.name, COALESCE(mapping.master, ${inventoryMasterSql('category')}) AS master,
      SUM(COALESCE(mapping.mapping_conflicts, 0)) AS mapping_conflicts
    FROM inventory_categories category
      LEFT JOIN inventory_items item ON item.category_id = category.id AND COALESCE(item.is_archived, 0) = 0
      LEFT JOIN inventory_masters mapping ON mapping.inventory_item_id = item.id
    GROUP BY category.id, category.name, COALESCE(mapping.master, ${inventoryMasterSql('category')})
    ORDER BY category.name, master`);
  const categories = new Map();
  for (const row of rows) {
    const entry = categories.get(row.id) || { id: row.id, name: row.name, masters: [], mapping_conflicts: 0 };
    entry.masters.push(row.master);
    entry.mapping_conflicts += Number(row.mapping_conflicts || 0);
    entry.master = entry.masters.length === 1 ? row.master : null;
    categories.set(row.id, entry);
  }
  return [...categories.values()];
}
