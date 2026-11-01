-- =====================================================================
-- Chulo Cottage — production seed (Postgres)
-- Run AFTER deploy/production_schema.sql on a fresh database.
--
-- Loads, idempotently (safe to re-run):
--   1. Chart of Accounts + default cash drawer / bank
--   2. Restaurant settings (Chulo Cottage branding, VAT/service, receipt)
--   3. First admin — login PIN 984898 (change after first sign-in)
--   4. Table floors, table types (categories) and tables T-01..T-12
--   5. Unit conversions (kg/g, l/ml, dozen/pcs, packet/pcs)
--   6. Full menu: 20 categories, 163 items and 58 variants, generated from
--      data/menu/chulo-cottage-menu.json (the menu on the cottage's own
--      website). Items sold in more than one filling or size carry real
--      menu_item_variants rows. Items carry a photo from public/images/dishes
--      where one matches, and a source_ref so
--      scripts/import-chulo-cottage-menu.mjs can sync later corrections.
--   7. Inventory categories + ingredient master (opening stock 0 — the
--      client fills real stock later)
--   8. An empty recipe shell for every menu item (no ingredient lines —
--      this menu's dish compositions weren't supplied, so none were
--      invented; fill recipes in later via Admin -> Recipes so stock
--      auto-deducts on sale)
--   9. schema_migrations markers 001..038 so `npm run db:migrate` is a
--      no-op afterwards (and only applies anything newer than this)
--
-- Markers used for idempotency:
--   recipes.prep_notes      = 'Default seed recipe'
--   inventory_items.notes   = 'Default seed ingredient'
--   unit_conversions.note   = 'Default seed'
-- =====================================================================

BEGIN;

-- pgcrypto is needed to hash the admin PIN below (bcrypt-compatible $2a$).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================ 1. ACCOUNTS
INSERT INTO accounts (code, name, type, subtype, is_system) VALUES
  ('1000','Assets','asset',NULL,1),
  ('1010','Cash on Hand','asset','cash',1),
  ('1020','Bank','asset','bank',1),
  ('1100','Card Clearing','asset','clearing',1),
  ('1110','eSewa Clearing','asset','clearing',1),
  ('1120','Khalti Clearing','asset','clearing',1),
  ('1130','QR / Fonepay Clearing','asset','clearing',1),
  ('1140','Online Clearing','asset','clearing',1),
  ('1200','Inventory','asset','inventory',1),
  ('1300','Accounts Receivable','asset','receivable',1),
  ('2000','Liabilities','liability',NULL,1),
  ('2010','Accounts Payable','liability','payable',1),
  ('2020','VAT / Tax Payable','liability','tax_payable',1),
  ('3000','Equity','equity',NULL,1),
  ('3010','Owner''s Equity','equity',NULL,1),
  ('3020','Opening Balance Equity','equity',NULL,1),
  ('4000','Income','income',NULL,1),
  ('4010','Sales Revenue','income','sales',1),
  ('4020','Other Income','income',NULL,1),
  ('5000','Expenses','expense',NULL,1),
  ('5010','Purchases / COGS','expense','cogs',1),
  ('5020','Operating Expenses','expense','operating',1),
  ('5030','Payroll','expense','payroll',1),
  ('5040','Wastage / Inventory Loss','expense','wastage',1),
  ('5050','Payment Processing Fees','expense','fees',1),
  ('5060','Cash Over / Short','expense','variance',1)
ON CONFLICT (code) DO NOTHING;

UPDATE accounts SET parent_id = (SELECT id FROM accounts WHERE code='1000') WHERE code IN ('1010','1020','1100','1110','1120','1130','1140','1200','1300') AND parent_id IS NULL;
UPDATE accounts SET parent_id = (SELECT id FROM accounts WHERE code='2000') WHERE code IN ('2010','2020') AND parent_id IS NULL;
UPDATE accounts SET parent_id = (SELECT id FROM accounts WHERE code='3000') WHERE code IN ('3010','3020') AND parent_id IS NULL;
UPDATE accounts SET parent_id = (SELECT id FROM accounts WHERE code='4000') WHERE code IN ('4010','4020') AND parent_id IS NULL;
UPDATE accounts SET parent_id = (SELECT id FROM accounts WHERE code='5000') WHERE code IN ('5010','5020','5030','5040','5050','5060') AND parent_id IS NULL;

INSERT INTO cash_drawers (name) SELECT 'Main Drawer' WHERE NOT EXISTS (SELECT 1 FROM cash_drawers);
INSERT INTO bank_accounts (name, account_id)
  SELECT 'Primary Bank', (SELECT id FROM accounts WHERE code='1020') WHERE NOT EXISTS (SELECT 1 FROM bank_accounts);

-- ============================================================ 2. SETTINGS
INSERT INTO system_settings (setting_key, setting_value) VALUES
  ('restaurant_name','Chulo Cottage'),
  ('restaurant_address','Birendranagar-8, Surkhet, Karnali Province, Nepal'),
  ('restaurant_phone','+977 984-1511535'),
  ('restaurant_email',''),
  ('vat_number',''),
  ('pan_number',''),
  ('vat_percentage','0'),
  ('service_charge_percentage','0'),
  ('currency','NPR'),
  ('receipt_footer','Thank you for visiting Chulo Cottage!'),
  ('receipt_paper_size','80'),
  ('website','https://chulocottage.com.np'),
  ('qr_ordering_enabled','true'),
  ('bank_qr_image',''),
  ('esewa_qr_image',''),
  ('reservation_hold_minutes','30'),
  ('reservation_grace_minutes','20'),
  ('reservation_dining_minutes','90'),
  ('reservation_cleaning_minutes','10'),
  ('reservation_auto_cancel_minutes','20'),
  ('reservation_min_lead_minutes','60')
ON CONFLICT (setting_key) DO NOTHING;

-- ============================================================== 3. ADMIN
-- Login is PIN-based. Seeded PIN = 984898. CHANGE after first sign-in
-- (must_change_password forces a reset on first login).
INSERT INTO users (username, password_hash, full_name, role, is_active, must_change_password)
VALUES ('admin', crypt('984898', gen_salt('bf', 12)), 'Restaurant Admin', 'admin', 1, 1)
ON CONFLICT (username) DO NOTHING;

-- ============================================================== 4. FLOORS
INSERT INTO table_floors (name, normalized_name, sort_order) VALUES
  ('Ground',  'ground',  1),
  ('First',   'first',   2),
  ('Rooftop', 'rooftop', 3),
  ('Outdoor', 'outdoor', 4)
ON CONFLICT (normalized_name) DO NOTHING;

-- ---- table types (a.k.a. table categories) ----
INSERT INTO table_types (name, normalized_name, color, default_capacity) VALUES
  ('Regular', 'regular', '#3b82f6', 4),
  ('VIP',     'vip',     '#a855f7', 6),
  ('Family',  'family',  '#22c55e', 6),
  ('Couple',  'couple',  '#ec4899', 2),
  ('Outdoor', 'outdoor', '#f59e0b', 4),
  ('Counter', 'counter', '#64748b', 2)
ON CONFLICT (normalized_name) DO NOTHING;

-- ---- tables T-01..T-12 ----
INSERT INTO tables (table_number, capacity, status, floor, section, table_type, is_active)
SELECT v.num, v.cap, 'available', v.floor, v.section, v.ttype, 1
FROM (VALUES
  ('T-01', 2, 'Ground',  'Main',    'couple'),
  ('T-02', 2, 'Ground',  'Main',    'couple'),
  ('T-03', 4, 'Ground',  'Main',    'regular'),
  ('T-04', 4, 'Ground',  'Main',    'regular'),
  ('T-05', 4, 'Ground',  'Main',    'regular'),
  ('T-06', 6, 'Ground',  'Main',    'family'),
  ('T-07', 4, 'First',   'Hall',    'regular'),
  ('T-08', 4, 'First',   'Hall',    'regular'),
  ('T-09', 6, 'First',   'Hall',    'family'),
  ('T-10', 6, 'First',   'VIP',     'vip'),
  ('T-11', 4, 'Rooftop', 'Terrace', 'outdoor'),
  ('T-12', 4, 'Rooftop', 'Terrace', 'outdoor')
) AS v(num, cap, floor, section, ttype)
WHERE NOT EXISTS (SELECT 1 FROM tables t WHERE t.table_number = v.num);

-- ==================================================== 5. UNIT CONVERSIONS
INSERT INTO unit_conversions (from_unit, to_unit, factor, note) VALUES
  ('kg',     'g',   1000,  'Default seed'),
  ('g',      'kg',  0.001, 'Default seed'),
  ('l',      'ml',  1000,  'Default seed'),
  ('ml',     'l',   0.001, 'Default seed'),
  ('dozen',  'pcs', 12,    'Default seed'),
  ('packet', 'pcs', 1,     'Default seed')
ON CONFLICT (from_unit, to_unit) DO NOTHING;

-- ================================================= 6. MENU CATEGORIES (20)
-- Generated from data/menu/chulo-cottage-menu.json (the menu on the cottage's
-- own website). Regenerate rather than hand-edit: that file is the source of
-- truth, and scripts/import-chulo-cottage-menu.mjs syncs a live database from
-- it by source_ref.
INSERT INTO menu_categories (name, display_order)
SELECT v.name, v.ord FROM (VALUES
  ('Mo:mo', 1),
  ('House special', 2),
  ('Chicken', 3),
  ('Mutton', 4),
  ('Veg snacks', 5),
  ('Salad', 6),
  ('Rice and biryani', 7),
  ('Curry and roti', 8),
  ('Noodles', 9),
  ('Soup and thukpa', 10),
  ('Burgers and sandwiches', 11),
  ('Kathi rolls', 12),
  ('Coffee', 13),
  ('Tea', 14),
  ('Fresh juice', 15),
  ('Lassi', 16),
  ('Cold drinks', 17),
  ('Beer and cider', 18),
  ('Spirits', 19),
  ('Hookah', 20)
) AS v(name, ord)
ON CONFLICT (name) DO NOTHING;

-- ================================================ 6a2. MASTER FOOD GROUPS
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS food_group TEXT DEFAULT 'food';
UPDATE menu_categories SET food_group = 'beverage'
WHERE name IN ('Coffee', 'Tea', 'Fresh juice', 'Lassi', 'Cold drinks', 'Beer and cider', 'Spirits', 'Hookah')
  AND COALESCE(food_group, 'food') <> 'beverage';
UPDATE menu_categories SET food_group = 'food'
WHERE name NOT IN ('Coffee', 'Tea', 'Fresh juice', 'Lassi', 'Cold drinks', 'Beer and cider', 'Spirits', 'Hookah')
  AND (food_group IS NULL OR food_group = '' OR lower(food_group) IN ('foods', 'beverages'));

-- ================================================= 6b. MENU ITEMS (163)
-- source_ref is the stable key scripts/import-chulo-cottage-menu.mjs matches on,
-- so a later menu correction updates these rows instead of duplicating them.
-- The column is created here because this seed runs before the migrations.
-- Photos are the files under public/images/dishes.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS source_ref TEXT;

INSERT INTO menu_items
  (source_ref, name, description, category_id, base_price, is_available, is_vegetarian, display_order, image_url)
SELECT v.ref, v.name, v.descr, c.id, v.price, 1, v.veg, v.ord, v.image
FROM (VALUES
  -- Mo:mo
  ('mo-mo-steam-momo','Steam momo',NULL,'Mo:mo',150,0,1,'/images/dishes/Chicken Steam Momo.jpg'),
  ('mo-mo-fried-momo','Fried momo',NULL,'Mo:mo',160,0,2,'/images/dishes/Chcken Fried Momo.jpg'),
  ('mo-mo-chilli-momo','Chilli momo',NULL,'Mo:mo',250,0,3,'/images/dishes/Chicken Chilly Momo.jpg'),
  ('mo-mo-c-momo','C. momo',NULL,'Mo:mo',230,0,4,'/images/dishes/Chicken C Momo.jpg'),
  ('mo-mo-kothey-momo','Kothey momo',NULL,'Mo:mo',170,0,5,'/images/dishes/fry-momo.jpg'),
  ('mo-mo-jhol-momo','Jhol momo',NULL,'Mo:mo',170,0,6,'/images/dishes/Chicken Jhol Momo.jpg'),
  ('mo-mo-hot-jhol-momo','Hot jhol momo',NULL,'Mo:mo',190,0,7,'/images/dishes/Chicken Jhol Momo.jpg'),
  ('mo-mo-sadeko-momo','Sadeko momo',NULL,'Mo:mo',200,0,8,NULL),
  -- House special
  ('house-spec-afghani-momo','Afghani momo',NULL,'House special',250,0,1,'/images/dishes/Chicken C Momo.jpg'),
  -- Chicken
  ('chicken-chicken-sekuwa','Chicken sekuwa',NULL,'Chicken',350,0,1,'/images/dishes/Chicken Sekuwa.jpg'),
  ('chicken-chicken-choila','Chicken choila',NULL,'Chicken',300,0,2,'/images/dishes/Chicken Chhoila.jpg'),
  ('chicken-chicken-lollipop','Chicken lollipop',NULL,'Chicken',250,0,3,'/images/dishes/Chicken Loly Pop.avif'),
  ('chicken-chicken-chilli','Chicken chilli',NULL,'Chicken',285,0,4,NULL),
  ('chicken-chicken-boil','Chicken boil',NULL,'Chicken',300,0,5,NULL),
  ('chicken-chicken-boil-sadeko','Chicken boil sadeko',NULL,'Chicken',320,0,6,NULL),
  ('chicken-chicken-sadeko','Chicken sadeko',NULL,'Chicken',280,0,7,NULL),
  ('chicken-chicken-nuggets','Chicken nuggets',NULL,'Chicken',300,0,8,NULL),
  ('chicken-chicken-65','Chicken 65',NULL,'Chicken',320,0,9,NULL),
  ('chicken-chicken-pakoda','Chicken pakoda',NULL,'Chicken',300,0,10,NULL),
  ('chicken-chicken-chatpate','Chicken chatpate',NULL,'Chicken',180,0,11,NULL),
  ('chicken-crispy-chicken','Crispy chicken',NULL,'Chicken',300,0,12,NULL),
  ('chicken-hot-wings','Hot wings',NULL,'Chicken',320,0,13,'/images/dishes/Chicken Wings.jpg'),
  ('chicken-kurkure-chicken','Kurkure chicken',NULL,'Chicken',350,0,14,NULL),
  ('chicken-kfc-style-chicken','KFC-style chicken',NULL,'Chicken',350,0,15,NULL),
  ('chicken-chicken-sausage','Chicken sausage',NULL,'Chicken',180,0,16,NULL),
  ('chicken-sausage-chilli','Sausage chilli',NULL,'Chicken',450,0,17,NULL),
  -- Mutton
  ('mutton-mutton-sekuwa','Mutton sekuwa',NULL,'Mutton',390,0,1,'/images/dishes/Mutton Sekuwa.jpg'),
  ('mutton-mutton-choila','Mutton choila',NULL,'Mutton',380,0,2,'/images/dishes/Mutton Chhoila.jpg'),
  ('mutton-mutton-kan-gidi-jibro','Mutton kan-gidi-jibro',NULL,'Mutton',350,0,3,NULL),
  ('mutton-bhutan','Bhutan',NULL,'Mutton',250,0,4,'/images/dishes/mutton bhutan.jpg'),
  ('mutton-mutton-tass','Mutton tass',NULL,'Mutton',390,0,5,'/images/dishes/Mutton Tass Set.jpg'),
  ('mutton-mutton-hekulla','Mutton hekulla',NULL,'Mutton',490,0,6,NULL),
  -- Veg snacks
  ('veg-snacks-french-fries','French fries',NULL,'Veg snacks',120,1,1,'/images/dishes/French Fries.jpg'),
  ('veg-snacks-peanut-sadeko','Peanut sadeko',NULL,'Veg snacks',140,1,2,NULL),
  ('veg-snacks-corn-salt-and-pepper','Corn salt and pepper',NULL,'Veg snacks',200,1,3,'/images/dishes/Corn Salt N Pepper.jpg'),
  ('veg-snacks-bhatmas-sadeko','Bhatmas sadeko',NULL,'Veg snacks',120,1,4,NULL),
  ('veg-snacks-hot-potato-chilli','Hot potato chilli',NULL,'Veg snacks',140,1,5,NULL),
  ('veg-snacks-paneer-chilli','Paneer chilli',NULL,'Veg snacks',290,1,6,NULL),
  ('veg-snacks-aloo-chop','Aloo chop',NULL,'Veg snacks',90,1,7,NULL),
  ('veg-snacks-aloo-paratha','Aloo paratha',NULL,'Veg snacks',120,1,8,'/images/dishes/Aloo Paratha.jpg'),
  ('veg-snacks-mustang-aloo','Mustang aloo',NULL,'Veg snacks',180,1,9,NULL),
  ('veg-snacks-paneer-pakoda','Paneer pakoda',NULL,'Veg snacks',300,1,10,'/images/dishes/Paneer Pakoda.jpg'),
  ('veg-snacks-chatpate','Chatpate',NULL,'Veg snacks',100,1,11,NULL),
  ('veg-snacks-sadeko-chauchau','Sadeko chauchau',NULL,'Veg snacks',150,1,12,NULL),
  ('veg-snacks-onion-rings','Onion rings',NULL,'Veg snacks',150,1,13,NULL),
  ('veg-snacks-veg-boil','Veg boil',NULL,'Veg snacks',200,1,14,'/images/dishes/veg boil.jpg'),
  ('veg-snacks-lasun-fry','Lasun fry',NULL,'Veg snacks',150,1,15,NULL),
  ('veg-snacks-pakoda','Pakoda',NULL,'Veg snacks',80,1,16,NULL),
  ('veg-snacks-laping-dry','Laping, dry',NULL,'Veg snacks',120,1,17,NULL),
  ('veg-snacks-laping-jhol','Laping, jhol',NULL,'Veg snacks',150,1,18,NULL),
  ('veg-snacks-safale','Safale',NULL,'Veg snacks',150,1,19,NULL),
  -- Salad
  ('salad-nepali-salad','Nepali salad',NULL,'Salad',150,1,1,NULL),
  ('salad-fruit-salad','Fruit salad',NULL,'Salad',200,1,2,NULL),
  ('salad-diamond-salad','Diamond salad',NULL,'Salad',250,1,3,NULL),
  -- Rice and biryani
  ('rice-and-b-veg-fried-rice','Veg fried rice',NULL,'Rice and biryani',170,1,1,'/images/dishes/Veg. Fried Rice.jpg'),
  ('rice-and-b-egg-fried-rice','Egg fried rice',NULL,'Rice and biryani',200,0,2,'/images/dishes/Egg Fried Rice.jpg'),
  ('rice-and-b-chicken-fried-rice','Chicken fried rice',NULL,'Rice and biryani',250,0,3,'/images/dishes/Chicken Fried Rice.jpg'),
  ('rice-and-b-paneer-fried-rice','Paneer fried rice',NULL,'Rice and biryani',300,1,4,NULL),
  ('rice-and-b-mix-fried-rice','Mix fried rice',NULL,'Rice and biryani',300,0,5,'/images/dishes/Mix Fried Rice.jpg'),
  ('rice-and-b-veg-biryani','Veg biryani',NULL,'Rice and biryani',270,1,6,NULL),
  ('rice-and-b-egg-biryani','Egg biryani',NULL,'Rice and biryani',290,0,7,NULL),
  ('rice-and-b-chicken-biryani','Chicken biryani',NULL,'Rice and biryani',350,0,8,NULL),
  ('rice-and-b-paneer-biryani','Paneer biryani',NULL,'Rice and biryani',490,1,9,NULL),
  ('rice-and-b-mutton-biryani','Mutton biryani',NULL,'Rice and biryani',500,0,10,NULL),
  -- Curry and roti
  ('curry-and--veg-curry','Veg curry',NULL,'Curry and roti',230,1,1,NULL),
  ('curry-and--egg-curry','Egg curry',NULL,'Curry and roti',260,0,2,NULL),
  ('curry-and--chicken-curry','Chicken curry',NULL,'Curry and roti',300,0,3,NULL),
  ('curry-and--paneer-curry','Paneer curry',NULL,'Curry and roti',350,1,4,NULL),
  ('curry-and--mutton-curry','Mutton curry',NULL,'Curry and roti',350,0,5,NULL),
  ('curry-and--plain-roti','Plain roti',NULL,'Curry and roti',20,1,6,NULL),
  ('curry-and--butter-roti','Butter roti',NULL,'Curry and roti',30,1,7,NULL),
  -- Noodles
  ('noodles-veg-chowmein','Veg chowmein',NULL,'Noodles',110,1,1,NULL),
  ('noodles-egg-chowmein','Egg chowmein',NULL,'Noodles',130,0,2,'/images/dishes/Egg Chowmin.jpg'),
  ('noodles-chicken-chowmein','Chicken chowmein',NULL,'Noodles',150,0,3,'/images/dishes/Chicken Chowmin.jpg'),
  ('noodles-mix-chowmein','Mix chowmein',NULL,'Noodles',250,0,4,NULL),
  ('noodles-keema-noodles','Keema noodles',NULL,'Noodles',250,0,5,NULL),
  -- Soup and thukpa
  ('soup-and-t-veg-manchow-soup','Veg manchow soup',NULL,'Soup and thukpa',150,1,1,NULL),
  ('soup-and-t-hot-and-sour-soup','Hot and sour soup',NULL,'Soup and thukpa',180,1,2,NULL),
  ('soup-and-t-chicken-manchow-soup','Chicken manchow soup',NULL,'Soup and thukpa',180,0,3,NULL),
  ('soup-and-t-chicken-hot-and-sour-soup','Chicken hot and sour soup',NULL,'Soup and thukpa',230,0,4,'/images/dishes/Chicken Hot N Sour.jpg'),
  ('soup-and-t-veg-thukpa','Veg thukpa',NULL,'Soup and thukpa',170,1,5,NULL),
  ('soup-and-t-chicken-thukpa','Chicken thukpa',NULL,'Soup and thukpa',200,0,6,'/images/dishes/Chicken Thupka.jpg'),
  -- Burgers and sandwiches
  ('burgers-an-veg-burger','Veg burger',NULL,'Burgers and sandwiches',150,1,1,NULL),
  ('burgers-an-chicken-burger','Chicken burger',NULL,'Burgers and sandwiches',210,0,2,'/images/dishes/Chicken Burger.jpg'),
  ('burgers-an-plain-sandwich','Plain sandwich',NULL,'Burgers and sandwiches',120,1,3,NULL),
  ('burgers-an-bread-omelette','Bread omelette',NULL,'Burgers and sandwiches',120,0,4,'/images/dishes/Bread Omelette.jpg'),
  ('burgers-an-boiled-egg','Boiled egg',NULL,'Burgers and sandwiches',100,0,5,NULL),
  ('burgers-an-plain-omelette','Plain omelette',NULL,'Burgers and sandwiches',100,0,6,NULL),
  -- Kathi rolls
  ('kathi-roll-veg-kathi-roll','Veg kathi roll',NULL,'Kathi rolls',170,1,1,NULL),
  ('kathi-roll-egg-kathi-roll','Egg kathi roll',NULL,'Kathi rolls',200,0,2,NULL),
  ('kathi-roll-chicken-kathi-roll','Chicken kathi roll',NULL,'Kathi rolls',250,0,3,NULL),
  ('kathi-roll-paneer-kathi-roll','Paneer kathi roll',NULL,'Kathi rolls',300,1,4,NULL),
  ('kathi-roll-chicken-spring-roll','Chicken spring roll',NULL,'Kathi rolls',220,0,5,NULL),
  -- Coffee
  ('coffee-espresso','Espresso',NULL,'Coffee',80,1,1,'/images/dishes/espresso.jpg'),
  ('coffee-americano-single','Americano, single',NULL,'Coffee',130,1,2,'/images/dishes/Americano.webp'),
  ('coffee-americano-double','Americano, double',NULL,'Coffee',150,1,3,'/images/dishes/Americano Double Shot.jpg'),
  ('coffee-espresso-con-panna','Espresso con panna',NULL,'Coffee',150,1,4,NULL),
  ('coffee-doppio','Doppio',NULL,'Coffee',150,1,5,'/images/dishes/doppio.webp'),
  ('coffee-caff-lungo','Caffè lungo',NULL,'Coffee',155,1,6,NULL),
  ('coffee-cappuccino','Cappuccino',NULL,'Coffee',170,1,7,'/images/dishes/Cappuccino.jpg'),
  ('coffee-doppio-with-honey','Doppio with honey',NULL,'Coffee',170,1,8,NULL),
  ('coffee-caff-latte','Caffè latte',NULL,'Coffee',200,1,9,'/images/dishes/Café latte.jpg'),
  ('coffee-flavoured-latte','Flavoured latte','Honey, vanilla or caramel','Coffee',200,1,10,NULL),
  ('coffee-affogato','Affogato',NULL,'Coffee',220,1,11,NULL),
  ('coffee-mojito','Mojito',NULL,'Coffee',260,1,12,'/images/dishes/Mojito.jpg'),
  -- Tea
  ('tea-black-tea','Black tea',NULL,'Tea',25,1,1,'/images/dishes/Black Tea.png'),
  ('tea-lemon-tea','Lemon tea',NULL,'Tea',30,1,2,NULL),
  ('tea-chulo-milk-tea','Chulo milk tea',NULL,'Tea',40,1,3,'/images/dishes/Milk Masala Tea.webp'),
  ('tea-hot-lemon','Hot lemon',NULL,'Tea',50,1,4,'/images/dishes/Hot Lemon.jpg'),
  ('tea-black-coffee','Black coffee',NULL,'Tea',80,1,5,'/images/dishes/Black Coffee Nascoffe.webp'),
  ('tea-milk-coffee','Milk coffee',NULL,'Tea',100,1,6,'/images/dishes/Milk Coffee Nascoffe.jpg'),
  ('tea-hot-lemon-with-honey-or-ginger','Hot lemon with honey or ginger',NULL,'Tea',140,1,7,NULL),
  ('tea-cold-coffee','Cold coffee',NULL,'Tea',160,1,8,NULL),
  -- Fresh juice
  ('fresh-juic-carrot-juice','Carrot juice',NULL,'Fresh juice',120,1,1,NULL),
  ('fresh-juic-watermelon-juice','Watermelon juice',NULL,'Fresh juice',120,1,2,NULL),
  ('fresh-juic-orange-juice','Orange juice',NULL,'Fresh juice',200,1,3,NULL),
  ('fresh-juic-papaya-juice','Papaya juice',NULL,'Fresh juice',250,1,4,NULL),
  ('fresh-juic-apple-juice','Apple juice',NULL,'Fresh juice',270,1,5,NULL),
  ('fresh-juic-mix-juice','Mix juice',NULL,'Fresh juice',300,1,6,NULL),
  ('fresh-juic-pomegranate-shake','Pomegranate shake',NULL,'Fresh juice',350,1,7,NULL),
  -- Lassi
  ('lassi-mohi','Mohi',NULL,'Lassi',60,1,1,NULL),
  ('lassi-plain-lassi','Plain lassi',NULL,'Lassi',80,1,2,'/images/dishes/Sweet Lassi.jpg'),
  ('lassi-banana-lassi','Banana lassi',NULL,'Lassi',120,1,3,'/images/dishes/Banana Lassi.jpg'),
  ('lassi-mango-lassi','Mango lassi',NULL,'Lassi',130,1,4,NULL),
  ('lassi-mix-lassi','Mix lassi',NULL,'Lassi',170,1,5,NULL),
  -- Cold drinks
  ('cold-drink-mineral-water','Mineral water',NULL,'Cold drinks',30,1,1,'/images/dishes/mineral water.webp'),
  ('cold-drink-dew-sprite-coke-or-fanta','Dew, Sprite, Coke or Fanta',NULL,'Cold drinks',80,1,2,'/images/dishes/Cold Drinks.jpg'),
  ('cold-drink-masala-soda','Masala soda','Dew, Sprite, Coke or Fanta','Cold drinks',110,1,3,NULL),
  ('cold-drink-red-bull-red','Red Bull Red',NULL,'Cold drinks',150,1,4,NULL),
  ('cold-drink-xtreme-energy-drink','Xtreme energy drink',NULL,'Cold drinks',160,1,5,NULL),
  ('cold-drink-red-bull-blue','Red Bull Blue',NULL,'Cold drinks',350,1,6,NULL),
  -- Beer and cider
  ('beer-and-c-gorkha-small','Gorkha, small',NULL,'Beer and cider',230,1,1,NULL),
  ('beer-and-c-arna-small','Arna, small',NULL,'Beer and cider',230,1,2,NULL),
  ('beer-and-c-tuborg-strong-small','Tuborg Strong, small',NULL,'Beer and cider',250,1,3,NULL),
  ('beer-and-c-barahsinghe-small','Barahsinghe, small',NULL,'Beer and cider',270,1,4,NULL),
  ('beer-and-c-apple-cider','Apple cider',NULL,'Beer and cider',280,1,5,NULL),
  ('beer-and-c-gorkha-large','Gorkha, large',NULL,'Beer and cider',460,1,6,'/images/dishes/Gorkha-Strong-Beer-Bottle-650ML.jpg'),
  ('beer-and-c-arna-large','Arna, large',NULL,'Beer and cider',460,1,7,NULL),
  ('beer-and-c-tuborg-strong-large','Tuborg Strong, large',NULL,'Beer and cider',500,1,8,'/images/dishes/Tuborg-Beer-Bottle-650ML.jpg'),
  ('beer-and-c-tuborg-deluxe','Tuborg Deluxe',NULL,'Beer and cider',550,1,9,NULL),
  ('beer-and-c-barahsinghe-large','Barahsinghe, large',NULL,'Beer and cider',550,1,10,NULL),
  ('beer-and-c-carlsberg','Carlsberg',NULL,'Beer and cider',590,1,11,NULL),
  -- Spirits
  ('spirits-blue-diamond','Blue Diamond',NULL,'Spirits',410,1,1,NULL),
  ('spirits-golden-oak','Golden Oak',NULL,'Spirits',420,1,2,NULL),
  ('spirits-khukuri-rum-white','Khukuri Rum White',NULL,'Spirits',600,1,3,NULL),
  ('spirits-seto-bagh','Seto Bagh',NULL,'Spirits',650,1,4,NULL),
  ('spirits-yeti-vodka','Yeti Vodka',NULL,'Spirits',670,1,5,'/images/dishes/yeti vodka.png'),
  ('spirits-8848-vodka','8848 Vodka',NULL,'Spirits',690,1,6,'/images/dishes/8848-Vodka-750ML.jpg'),
  ('spirits-nude-vodka','Nude Vodka',NULL,'Spirits',690,1,7,NULL),
  ('spirits-ruslan-vodka','Ruslan Vodka',NULL,'Spirits',690,1,8,NULL),
  ('spirits-khukuri-rum-xxx','Khukuri Rum XXX',NULL,'Spirits',700,1,9,NULL),
  ('spirits-khukuri-rum-spice','Khukuri Rum Spice',NULL,'Spirits',750,1,10,NULL),
  ('spirits-signature-green','Signature Green',NULL,'Spirits',770,1,11,NULL),
  ('spirits-signature-red','Signature Red',NULL,'Spirits',780,1,12,NULL),
  ('spirits-gorkha-guns','Gorkha Guns',NULL,'Spirits',850,1,13,NULL),
  ('spirits-old-durbar-red','Old Durbar Red',NULL,'Spirits',900,1,14,NULL),
  ('spirits-himalayan-reserve','Himalayan Reserve',NULL,'Spirits',1000,1,15,NULL),
  ('spirits-old-durbar-black','Old Durbar Black',NULL,'Spirits',1150,1,16,NULL),
  -- Hookah
  ('hookah-hookah','Hookah',NULL,'Hookah',380,1,1,'/images/dishes/Hookah.jpg'),
  ('hookah-cloud-hookah','Cloud hookah',NULL,'Hookah',450,1,2,'/images/dishes/Hookah ambience.jpg'),
  ('hookah-extra-coil','Extra coil',NULL,'Hookah',50,1,3,NULL),
  ('hookah-hookah-refill','Hookah refill',NULL,'Hookah',250,1,4,NULL),
  ('hookah-cloud-hookah-refill','Cloud hookah refill',NULL,'Hookah',350,1,5,NULL)
) AS v(ref, name, descr, cat, price, veg, ord, image)
JOIN menu_categories c ON c.name = v.cat
WHERE NOT EXISTS (
  SELECT 1 FROM menu_items m WHERE m.name = v.name AND m.category_id = c.id
);

-- ============================================ 6c. MENU ITEM VARIANTS (58)
-- price is the absolute price the POS and the public menu bill at;
-- price_modifier is kept in sync as the delta from base_price so the older
-- code paths that only know the modifier still charge correctly. The price
-- column is added lazily by the app at runtime, so it is created here to keep
-- this seed standalone. The first variant listed for an item is its default
-- and carries the same price as the item's base_price.
ALTER TABLE menu_item_variants ADD COLUMN IF NOT EXISTS price DOUBLE PRECISION;

INSERT INTO menu_item_variants (menu_item_id, variant_name, price, price_modifier, is_default)
SELECT m.id, v.variant_name, v.price, v.price - m.base_price, v.is_default
FROM (VALUES
  -- Mo:mo
  ('Steam momo','Mo:mo','Chicken',150,1),
  ('Steam momo','Mo:mo','Mutton',200,0),
  ('Steam momo','Mo:mo','Paneer',160,0),
  ('Fried momo','Mo:mo','Chicken',160,1),
  ('Fried momo','Mo:mo','Mutton',220,0),
  ('Fried momo','Mo:mo','Paneer',180,0),
  ('Chilli momo','Mo:mo','Chicken',250,1),
  ('Chilli momo','Mo:mo','Mutton',280,0),
  ('Chilli momo','Mo:mo','Paneer',200,0),
  ('C. momo','Mo:mo','Chicken',230,1),
  ('C. momo','Mo:mo','Mutton',270,0),
  ('C. momo','Mo:mo','Paneer',190,0),
  ('Kothey momo','Mo:mo','Chicken',170,1),
  ('Kothey momo','Mo:mo','Mutton',220,0),
  ('Kothey momo','Mo:mo','Paneer',180,0),
  ('Jhol momo','Mo:mo','Chicken',170,1),
  ('Jhol momo','Mo:mo','Mutton',220,0),
  ('Jhol momo','Mo:mo','Paneer',180,0),
  ('Hot jhol momo','Mo:mo','Chicken',190,1),
  ('Hot jhol momo','Mo:mo','Mutton',240,0),
  ('Hot jhol momo','Mo:mo','Paneer',190,0),
  ('Sadeko momo','Mo:mo','Chicken',200,1),
  ('Sadeko momo','Mo:mo','Mutton',240,0),
  ('Sadeko momo','Mo:mo','Paneer',200,0),
  -- Tea
  ('Hot lemon with honey or ginger','Tea','Honey',140,1),
  ('Hot lemon with honey or ginger','Tea','Ginger',160,0),
  -- Spirits
  ('Blue Diamond','Spirits','180 ml',410,1),
  ('Blue Diamond','Spirits','750 ml',1640,0),
  ('Golden Oak','Spirits','180 ml',420,1),
  ('Golden Oak','Spirits','750 ml',1680,0),
  ('Khukuri Rum White','Spirits','180 ml',600,1),
  ('Khukuri Rum White','Spirits','750 ml',2400,0),
  ('Seto Bagh','Spirits','180 ml',650,1),
  ('Seto Bagh','Spirits','750 ml',2600,0),
  ('Yeti Vodka','Spirits','180 ml',670,1),
  ('Yeti Vodka','Spirits','750 ml',2680,0),
  ('8848 Vodka','Spirits','180 ml',690,1),
  ('8848 Vodka','Spirits','750 ml',2760,0),
  ('Nude Vodka','Spirits','180 ml',690,1),
  ('Nude Vodka','Spirits','750 ml',2760,0),
  ('Ruslan Vodka','Spirits','180 ml',690,1),
  ('Ruslan Vodka','Spirits','750 ml',2760,0),
  ('Khukuri Rum XXX','Spirits','180 ml',700,1),
  ('Khukuri Rum XXX','Spirits','750 ml',2800,0),
  ('Khukuri Rum Spice','Spirits','180 ml',750,1),
  ('Khukuri Rum Spice','Spirits','750 ml',3000,0),
  ('Signature Green','Spirits','180 ml',770,1),
  ('Signature Green','Spirits','750 ml',3080,0),
  ('Signature Red','Spirits','180 ml',780,1),
  ('Signature Red','Spirits','750 ml',3120,0),
  ('Gorkha Guns','Spirits','180 ml',850,1),
  ('Gorkha Guns','Spirits','750 ml',3400,0),
  ('Old Durbar Red','Spirits','180 ml',900,1),
  ('Old Durbar Red','Spirits','750 ml',3600,0),
  ('Himalayan Reserve','Spirits','180 ml',1000,1),
  ('Himalayan Reserve','Spirits','750 ml',4000,0),
  ('Old Durbar Black','Spirits','180 ml',1150,1),
  ('Old Durbar Black','Spirits','750 ml',4600,0)
) AS v(item, cat, variant_name, price, is_default)
JOIN menu_categories c ON c.name = v.cat
JOIN menu_items m ON m.name = v.item AND m.category_id = c.id
WHERE NOT EXISTS (
  SELECT 1 FROM menu_item_variants x
  WHERE x.menu_item_id = m.id AND x.variant_name = v.variant_name
);
-- ================================================ 7. INVENTORY CATEGORIES
INSERT INTO inventory_categories (name, normalized_name)
SELECT v.name, lower(v.name) FROM (VALUES
  ('Grains & Flour'),
  ('Bakery'),
  ('Meat & Poultry'),
  ('Vegetables'),
  ('Fruits'),
  ('Dairy'),
  ('Oil & Fats'),
  ('Spices & Condiments'),
  ('Beverages')
) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM inventory_categories c WHERE lower(c.name) = lower(v.name));

-- ===================================== 7b. INGREDIENT MASTER (opening stock 0)
-- quantity = 0 on purpose: the client enters real stock later. cost/min are 0
-- too; only the recipe lines below carry per-dish amounts.
INSERT INTO inventory_items
  (item_name, name, quantity, unit, cost_per_unit, min_stock_level, min_stock, category, supplier, notes, created_at, updated_at)
SELECT v.item_name, v.item_name, 0, v.unit, 0, 0, 0, v.category,
       'To be set', 'Default seed ingredient', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  -- Grains & Flour
  ('Rice','kg','Grains & Flour'),
  ('Basmati Rice','kg','Grains & Flour'),
  ('Maida (Flour)','kg','Grains & Flour'),
  ('Chowmein Noodles','kg','Grains & Flour'),
  ('Corn Kernels','kg','Grains & Flour'),
  -- Bakery
  ('Bread','pcs','Bakery'),
  ('Burger Bun','pcs','Bakery'),
  ('Pizza Base','pcs','Bakery'),
  ('Oreo Biscuit','pcs','Bakery'),
  -- Meat & Poultry
  ('Chicken','kg','Meat & Poultry'),
  ('Mutton','kg','Meat & Poultry'),
  ('Chicken Liver','kg','Meat & Poultry'),
  ('Chicken Sausage','pcs','Meat & Poultry'),
  ('Eggs','pcs','Meat & Poultry'),
  -- Vegetables
  ('Potato','kg','Vegetables'),
  ('Onion','kg','Vegetables'),
  ('Tomato','kg','Vegetables'),
  ('Mushroom','kg','Vegetables'),
  ('Mixed Vegetables','kg','Vegetables'),
  ('Peanuts','kg','Vegetables'),
  ('Cashew Nut','kg','Vegetables'),
  ('Mint Leaves','kg','Vegetables'),
  ('Lemon','pcs','Vegetables'),
  -- Fruits
  ('Watermelon','kg','Fruits'),
  ('Apple','kg','Fruits'),
  ('Orange','kg','Fruits'),
  ('Banana','pcs','Fruits'),
  ('Mixed Fruits','kg','Fruits'),
  -- Dairy
  ('Paneer','kg','Dairy'),
  ('Milk','l','Dairy'),
  ('Cheese','kg','Dairy'),
  ('Cream','l','Dairy'),
  ('Curd','kg','Dairy'),
  ('Ice Cream','l','Dairy'),
  -- Oil & Fats
  ('Cooking Oil','l','Oil & Fats'),
  ('Mustard Oil','l','Oil & Fats'),
  ('Ghee','kg','Oil & Fats'),
  -- Spices & Condiments
  ('Salt','kg','Spices & Condiments'),
  ('Sugar','kg','Spices & Condiments'),
  ('Mixed Spices (Masala)','kg','Spices & Condiments'),
  ('Biryani Masala','kg','Spices & Condiments'),
  ('Timur','kg','Spices & Condiments'),
  ('Black Pepper','kg','Spices & Condiments'),
  ('Soy Sauce','l','Spices & Condiments'),
  ('Chilli Sauce','l','Spices & Condiments'),
  ('Honey','kg','Spices & Condiments'),
  -- Beverages
  ('Coffee Powder','kg','Beverages'),
  ('Instant Coffee (Nescafe)','kg','Beverages'),
  ('Tea Leaves','kg','Beverages'),
  ('Green Tea Bag','pcs','Beverages'),
  ('Herbal Tea Bag','pcs','Beverages'),
  ('Cola Syrup','l','Beverages'),
  ('Chocolate Syrup','l','Beverages'),
  ('Real Juice Pack','pcs','Beverages'),
  ('Cold Drink Bottle','pcs','Beverages'),
  ('Red Bull Can','pcs','Beverages')
) AS v(item_name, unit, category)
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_items i WHERE i.item_name = v.item_name AND i.notes = 'Default seed ingredient'
);

-- Backfill category_id from the category text.
UPDATE inventory_items i
SET category_id = c.id
FROM inventory_categories c
WHERE lower(c.name) = lower(i.category)
  AND i.category_id IS NULL
  AND i.notes = 'Default seed ingredient';

-- ================================================= 8. RECIPES (one per item)
INSERT INTO recipes (name, type, menu_item_id, yield_quantity, yield_unit, prep_notes)
SELECT m.name, 'menu_item', m.id, 1, 'plate', 'Default seed recipe'
FROM menu_items m
WHERE NOT EXISTS (
  SELECT 1 FROM recipes r WHERE r.menu_item_id = m.id AND r.prep_notes = 'Default seed recipe'
);
-- ============================================ 9. MIGRATION MARKERS (001..038)
INSERT INTO schema_migrations (version) VALUES
  ('001_init'),('002_tables_extra_columns'),('003_expenses_notes_stock'),('004_recipe_bom'),
  ('005_leads_viewed_at'),('006_inventory_expense_upgrade'),('007_inventory_category'),('008_inventory_ledger'),
  ('009_wastage_reason_vocabulary'),('010_list_query_indexes'),('011_unit_conversions'),('012_inventory_categories'),
  ('013_table_floors_types'),('014_payroll'),('015_accounting'),('016_expense_categories'),
  ('017_accounting_hardening'),('018_accounting_numeric'),('019_supplier_ledger'),('020_bank_reconciliation'),
  ('021_table_qr_token'),('022_kitchen_timing'),('023_bill_corrections'),('024_online_orders'),
  ('025_bill_admin'),('026_split_billing'),('027_vat_payable_account'),('028_admin_pos_kot'),
  ('029_order_party'),('030_pos_lifecycle_audit_numbers'),('031_analytics_overview_indexes'),('032_business_days'),
  ('033_business_day_sessions'),('034_opening_cash_movement_accounts'),('035_inventory_business_day_attribution'),
  ('036_savings_deposits'),('037_business_day_stale_ack'),('038_role_permissions')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Sanity checks (run separately if you like):
--   SELECT COUNT(*) FROM menu_categories;      -- 20
--   SELECT COUNT(*) FROM menu_items;           -- 163
--   SELECT COUNT(*) FROM menu_item_variants;   -- 58
--   SELECT COUNT(*) FROM recipes;              -- 163 (empty shells)
--   SELECT COUNT(*) FROM inventory_items;      -- 56 (all quantity 0)
--   SELECT COUNT(*) FROM tables;               -- 12
--   SELECT COUNT(*) FROM business_days;        -- 0 (open one from Admin -> Opening & Closing)
