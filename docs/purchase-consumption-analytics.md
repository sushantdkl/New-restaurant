# Purchase, consumption and profitability analytics

Implementation date: 25 October 2026. This extends the existing Next.js POS, PostgreSQL migrations, SQLite development fallback, stock ledger, recipe builder, business-day attribution and dynamic role permissions. No production database or deployment was changed.

## Local demo, simpler view and 80mm printing

The screen follows the other reports: a compact title/action row, filter bar and plain table with totals. Dashboard cards, duplicate navigation, charts and accounting panels have been removed. Tables scroll horizontally on phones. Choose a master category, an inventory/menu category, or category/item grouping directly; the combined comparison uses shared master categories because menu and inventory category IDs are distinct.

**Print 80mm** creates a separate report-only document at the shared receipt system's 72mm printable width on 80mm paper. It uses 14px black text, category sections and explicit label/value lines instead of shrinking a wide table. It fetches every matching report row and preserves the selected scope. The printed document contains no sidebar, navigation, filters, action buttons, charts or raw accounting diagnostics. Missing profit remains unavailable. Demo business days are stamped **DEMO - SAMPLE DATA**. **A4 / PDF** uses the same report-only document. In the print dialog, select the 80mm printer/paper, 100% scale, and disable browser headers/footers. Physical printer hardware was not available for a paper-output test.

The user authorized a backup and rollover of the local SQLite's stale 23 September business day. `scripts/seed-sqlite-analytics-demo.mjs` backed up `pos_restaurant.db` with SQLite's online backup API, closed the stale session through the existing forced-close workflow, retained unfinished work, and opened business day **#60, 25 October 2026**. The simulated closing count is explicitly documented in the session note; it is not presented as a physical cash count. Closed demo history was added for **#61, 23 October**, and **#62, 24 October**.

The original pre-rollover backup is `.build-tmp/before-analytics-demo-1792910232079.db`. All 94 original order statuses and all 69 original bill totals were checked against it and retained. Sample records use `[DEMO]` names and `DEMO-ANALYTICS-…` references. The demo includes 8 stock items, 4 menu items, 2 recipes, 9 purchase invoices, 12 paid sales and 2 wastage entries. Reruns skip existing invoice/bill/wastage references rather than duplicating stock changes. Existing unpriced inventory is not assigned made-up costs.

Open `/admin/purchase-vs-sales?businessDayId=60` in the local application. Today's demo shows **NPR 5,520 purchased; NPR 14,440 sold; NPR 5,204.30 used for sales; NPR 9,235.70 gross profit; 63.96% margin; NPR 55 wastage**. Current stock value includes pre-existing inventory; one pre-existing item still needs a cost.

To seed another **local SQLite** copy, use the explicit path and loader:

```bash
node --import ./tests/unit/loader-register.mjs scripts/seed-sqlite-analytics-demo.mjs --db=databases/YOUR_LOCAL_COPY.db
```

The database must already exist inside the workspace. PostgreSQL and production mode are rejected. A stale active day stops the script unless `--rollover` is explicitly supplied after authorizing its close. Never run this against real production data. The current local database has already been seeded; refreshing the report is sufficient.

## Delivered behavior

- Reports navigation now includes Purchase Analysis, Sales & Recipe Cost, Purchase vs Sales Analysis and Inventory Consumption. Equivalent cashier routes require the new confidential reporting permission.
- Purchase hierarchy: inventory master category → inventory category → purchased SKU → received invoice lines. Saved inventory-category assignments take precedence. Otherwise each inventory item follows explicit direct menu links, variant stock links and active recipes, including nested sub-recipes. If all reachable menu categories agree on one master, that is the effective inventory master. Direct stock links suppress the same menu item's stale base recipe, matching the stock deduction precedence. Distinct menu/recipe paths never duplicate a purchase line or stock value. Items shared across different menu masters remain Uncategorised with a review flag until an inventory-category master is assigned; an explicit Uncategorised assignment is also respected. Only items without links use exact legacy category-name defaults from `lib/inventory-master.js`. Linked items with an explicitly Uncategorised menu master remain Uncategorised rather than falling back to the inventory category name.
- Category setup displays the effective masters represented by its items and counts unresolved shared items. A single inventory category may contain items resolving to different masters; the category table still returns one row, while master filters and item drilldowns select the appropriate items. Item reports show the classification source. Classification follows current links and assignments; it does not reconstruct historical mapping changes or reprice historical sales.
- Sales hierarchy: menu master category → menu category → menu item → attributed ingredient movements and the current recipe preview. Liquor is now an explicit master category in the existing vocabulary.
- Eleven period choices: today, yesterday, last 3/7/30 days, this week, this month, last month, this quarter, this year and custom AD/BS dates. Category, business day, name and purchase supplier filters apply equally to the table, print and downloads. Changing the period or custom dates clears a selected business day. Reset clears filters. Business days are selected by stored IDs.
- Backend aggregates return gross sales, bill discounts, allocated net refunds, net sales, recorded consumption cost, conditional gross profit/margin, current stock value, shortages and missing attribution/cost counts. Purchases separately expose line value, discounts, tax, shipping, invoice value, quantity/unit, average price and current stock.
- Chart data remains available through the optional API parameter; the report screen does not request or display charts.
- Excel XML `.xls`, CSV and full-filter print/browser Save as PDF. Print/export fetch the entire filtered aggregate, rather than the visible page. Unknown costs/profits remain blank/unavailable. Files include currency, scope and calculation methodology. PDF uses the browser print dialog; there is no server PDF renderer.
- Read-only purchase source checks compare invoices against linked expenses and flag missing/duplicate expenses and missing/unbalanced source journals. Their whole-invoice scope is labeled independently from category filters.

## Inventory and recipe integration

The authoritative event remains the existing order/create/add/quantity-change lifecycle. KOT printing and payment do not acquire a second stock-deduction path. Direct links retain precedence over recipes; variants retain their own usage quantity and units. Shared ingredients continue through `applyStockChange` and the existing moving-average policy.

Every new attributed stock movement stores menu ID, variant, a consumption group key, sold quantity, root recipe/version/costing basis and cost status. The existing movement quantity, requested quantity, variance, unit cost, business day and order reference are the immutable physical/cost evidence. Recipe edits never reprice these movements. Insufficient stock follows the existing clamp-at-zero and recorded-variance policy; the resulting profit is unavailable, rather than treating an unfulfilled deduction as full COGS.

The existing recipe tables gain activation, version and ingredient preparation-loss fields. Definitions are archived on creation and before/after edits. Validation rejects nonpositive yields/quantities, invalid ingredient references, invalid conversion paths, cycles/deep nesting and invalid loss percentages. Unit conversion supports physical ratios, existing custom conversions and each SKU's purchase-to-consumption factor (for example 750 ml/bottle). Sub-recipes retain yield scaling. Changes become effective immediately; the version history records when each definition was captured.

The recipe builder now shows a debounced **server** cost preview, missing-cost/stock warnings, activation and preparation loss. Preview cost accumulation uses integer paisa. Zero/unverified ingredient costs make the cost preview unavailable. Recipe list/detail margins use cost per serving, rather than the whole batch. Deleting a recipe deactivates it and retains definitions/history.

When an existing business workflow explicitly restores stock, newly attributed sales restore the recorded ingredients and original costs. Outstanding movements for the same order/menu/variant are restored proportionally; quantities cannot exceed the outstanding recorded deduction. Existing prepared-food wastage/refund decisions stay with their existing callers. Legacy orders without snapshots retain the previous restoration fallback.

`inventory_operations` supplies durable transaction receipts, including unmapped sales that produced no movement. Initial orders, checkout, online checkout and item-ID-backed POS additions use operation keys. PostgreSQL locks the order and inventory rows inside the caller's transaction. Replaying a key returns the stored result; using it with different input returns 409. Rollback removes both movement and receipt.

POS item-add POST also accepts `Idempotency-Key` or `idempotency_key`; its receipt covers order-line insertion and stock consumption together. The POS client supplies a key. Quantity updates serialize on the order and compute the delta from current stored quantity. External/legacy callers without a stable retry key retain their existing mutation semantics: integrations must reuse a key for retries. A new key represents a new operation.

## Accounting and dates

The repository explicitly uses **purchases as expenses**, rather than perpetual COGS. This feature retains that policy and posts no journals. Actual posted COGS is unavailable. Gross profit is labeled as sales less recorded consumption cost; it is not net operating profit or a statement that COGS reconciles to the GL.

Purchase invoice value includes the existing header adjustments. It is distinct from moving-average inventory valuation: the existing receiving ledger values stock using received quantities and entered unit cost. This feature does not change capitalization, recoverable-tax or purchasing policy. Source checks diagnose inconsistencies without repairing or posting anything.

Purchase periods and daily charts use invoice date, falling back to the Nepal date of `created_at` when absent, matching Purchases Report even for invoices entered later. Sales use bill `created_at`, and inventory/wastage use movement creation timestamps. A selected business day overrides date bounds. Purchases inherit their assigned day from the existing linked purchase expense; there is no invented `purchases.business_day_id` column. Sales use bill business days and inventory uses movement business days. Unavailable cost and profit values display as an em dash on screen and in print; they remain null in the API.

Sales consumption is attributed to the original bill's scope, even when an order consumed stock earlier. The inventory view shows movements occurring in the selected period, including unbilled orders. These are deliberately different metrics. Refund amounts are allocated net of bill tax/service charges against the original bill; later refunds therefore revise that bill's net-sales figure, following the bill's current refund state. They are not represented as item-specific supplier/customer credit notes.

The inventory table exposes Deducted, Restored and Net used separately. Net used can be negative when restorations exceed deductions within the period. Missing/zero movement costs and explicit incomplete cost statuses flag partial usage values; unrelated purchase/adjustment movements do not trigger a usage warning. Screen and print use dashes for unavailable costs/profit and inline partial-value markers; explanatory blocks and date-basis prose are omitted. Report navigation carries the period, custom dates, business day and master selection across reports; inventory and menu category IDs remain separate.

In Purchase vs Sales Analysis, clicking a master opens its menu subcategories (`mode=combined&level=category&master=...`); Back to all categories restores the master view while keeping dates and other filters. Purchase lines use distinct direct menu, variant and active nested recipe links within their effective master to join a menu subcategory. Multiple matching subcategories place the purchase once under Shared stock; no matching links place it under Unlinked stock. Names and inventory category IDs never infer a menu link. Sales and saved consumption costs group by their menu categories. Category exports and both print sizes use the same filtered drilldown rows and totals.

Linked master classification is shared by purchase/inventory aggregates, the combined comparison, category pickers, category setup, filtered charts and exports. Historical sales consumption continues to use the original recorded ingredient movements. Current links alone cannot reconstruct missing historical ingredient costs. Recursive classification uses distinct reachable recipe/menu pairs so legacy cycles terminate without multiplying invoice values; recipe validation and costing still reject invalid cycles.

Liquor belongs to the Beverages master. Legacy `liquor`, `alcohol` and `alcoholic` master assignments resolve to `beverage` in both JavaScript and SQL without rewriting invoices or sales. Individual menu category names stay intact. Analysis master filters offer groups used by the relevant current setup, and menu category pickers exclude inactive/deleted categories. Category Sales & Stock also drops stale saved category selections.

Wastage trend data comes from `wastage_log`, including prepared cancellations with no second stock deduction. Inventory-table wastage represents actual wastage stock movements. The chart's broader date/master scope is explicitly labeled; item/category/search/supplier filters do not apply to that chart. Current stock and value are **now**, not reconstructed period-end balances.

## API

`GET /api/admin/purchase-sales-analysis`

| Parameter | Values |
|---|---|
| `mode` | `combined`, `purchases`, `sales`, `inventory` |
| `level` | `master`, `category`, `item`; combined is always master |
| `period` | existing presets, including `today`, `yesterday`, `this_week`, `this_month`, `last_month`, `custom` |
| `startDate`, `endDate`, `calendarSystem` | custom dates and existing calendar handling |
| `businessDayId` | stored business-day ID; today defaults to the open day |
| `master`, `categoryId`, `itemId`, `search` | hierarchy/name filtering; inventory and sales category IDs remain distinct |
| `supplierId` | purchase mode only |
| `page`, `page_size`, `sort`, `dir` | server pagination, capped page size, allowlisted sorting |
| `detail=1` | selected item's purchase lines or attributed ingredient movements, with pagination |
| `charts=1` | SQL-aggregated charts and wastage scope |
| `format=csv` or `format=xls` | complete filtered export |
| `export=1` | complete aggregate for printing |

`POST /api/admin/recipes/preview` validates/prices an unsaved definition without creating a recipe or stock movement. Existing recipe CRUD and inventory-category endpoints are extended rather than duplicated.

All new report reads, detail reads and exports require `report.profitability.view` and admin/cashier role eligibility. Admin is unrestricted; the permission defaults off for cashier, waiter and kitchen. There is no manager role in this repository. UI permission checks supplement the API guard. Preview requires existing `menu.manage` and CSRF protection follows the shared guard.

## Routes

`/admin/purchase-analysis`, `/admin/sales-recipe-cost`, `/admin/purchase-vs-sales`, `/admin/inventory-consumption`, with corresponding `/cashier/…` wrappers.

Existing invoice/order/recipe pages supply transaction drill-through links. The combined view opens master-category comparisons, then lets the owner choose the inventory purchase hierarchy or menu sales hierarchy.

## Migration and changed files

Only **074_purchase_consumption_analytics.sql** was added by this feature. It adds fields to inventory categories, recipes, recipe items and stock movements; creates recipe-version and inventory-operation receipt tables; and adds reporting indexes. Existing migrations 072/073 and other local payroll/payment/purchase changes predated this task and were preserved. Review them separately before deploying a working tree containing them.

Feature files:

| Area | Created or modified |
|---|---|
| Backend | `lib/purchase-sales-analysis.js`, `analysis-charts.js`, `analysis-export.js`, `analysis-reconciliation.js`, `inventory-operations.js`, `recipe-history.js`; shared display/print helpers `analysis-presentation.js`, `analysis-print.js` |
| Existing domain | `lib/stock.js`, `stock-movements.js`, `inventory-ledger.js`, `recipes.js`, `inventory-categories.js`, `food-groups.js`, `permissions.js`, `staff-access-policy.js`, `online-orders.js`, `lib/db/repositories/orders.js` |
| APIs | new report/recipe-preview routes; existing inventory-category, recipe, billing and POS order-item routes |
| UI | new shared `components/admin/purchase-sales-analysis.jsx`, eight report route wrappers, admin navigation, inventory-category setup, recipe panel/list/detail |
| Verification | new unit/PostgreSQL/browser tests, including report-only 80mm document checks; local-only `scripts/seed-sqlite-analytics-demo.mjs`; integration runner supports selecting a feature test file; optional Playwright browser channel; optional isolated Next build directory and corresponding ignores |
| Build | removed unused Google font initializers from `app/layout.js` and supplied explicit system-font fallbacks in `app/globals.css`; this removes an unnecessary external font-download build dependency while retaining the sans-serif UI |
| Docs | this guide and documentation index |

No historical stock, purchase, bill or journal backfill runs. New foreign keys retain historical recipes/operation receipts. Rollback should restore the previous **application** and leave additive schema/audit data in place; do not drop these tables after real activity. Older code can write movements without attribution, which the new analytics later marks incomplete.

## Verification

- Unit suite: **373 passed**.
- Dedicated PostgreSQL 17 feature suite: **2 passed**, with all migrations applied to disposable localhost databases. Covers concurrent retries, rollback, portions, snapshots, discounts/refunds, all drill levels, date versus linked-expense business-day attribution, recipe versions, conversion/loss, shortage policy, source checks, charts and protected APIs/exports.
- Desktop and mobile browser acceptance: **6 passed** using installed Edge against the user-authorized local SQLite demo. Covers four report routes, category filters, custom BS/AD dates, filtered Excel/CSV downloads, document overflow and the isolated 72mm-wide print document. Printed totals and scope match the filtered table; no physical print job was sent.
- Repository lint: **0 errors, 31 existing warnings**.
- Production webpack build: verified with an isolated `POS_BUILD_DIR` and `SKIP_DB_ON_BUILD=1`; requires no production database.
- Full existing PostgreSQL integration suite was run. Its legacy production fixture stops at `next_business_day_confirmation_required` because its `start_next` request omits `confirm_next_day`. A temporary confirmation also exposed a pre-existing reopened-credit expectation mismatch (expected 113, got 87 at `production.test.js:114`, under current tax/settings behavior). No financial assertion or existing validation was weakened; that fixture was restored unchanged. This remains a release verification issue.

Reproduce feature PostgreSQL verification against an **isolated localhost server only**:

```bash
TEST_DATABASE_URL=postgresql://TEST_USER@127.0.0.1:55439/postgres npm run test:integration -- tests/integration/purchase-sales-analysis.test.js
```

The runner creates and drops only its own `km_test_*` database. Never use the production URL as a test URL. Browser test command, against a disposable seeded dev server:

```bash
E2E_BASE_URL=http://127.0.0.1:3007 E2E_ADMIN_PIN=YOUR_TEST_PIN E2E_BROWSER_CHANNEL=msedge npx playwright test tests/e2e/purchase-sales-analysis.spec.js
```

## Remaining limits / release dependencies

1. Historical movements without menu attribution are not retrospectively priced. Partially attributed orders and unmatched combo component quantities show unavailable profitability. No historical estimates are passed off as verified consumption.
2. Supplier credit-note purchase returns, scheduled future recipe versions, explicit substitutions and separate direct-pour loss fields are not present in the underlying workflows and were not fabricated. Purchase voids remain the supported reversal. Recipe preparation loss is an additional usage percentage and is not a separate automatically posted wastage journal.
3. Legacy/external mutations need stable operation keys for retry guarantees. Same-order/menu/variant restorations allocate outstanding recorded ingredient quantities proportionally, rather than identifying a particular plate across multiple recipe versions. Legacy restorations retain the existing fallback.
4. Zero cost cannot currently be distinguished from a missing/default cost in inventory. Zero/unverified values remain unavailable rather than implying a free ingredient and overstating profit.
5. Purchase source checks are not a full account-by-account GL reconciliation. Actual perpetual COGS requires a separately approved accounting-policy change.
6. No production-volume load benchmark or exhaustive transfer/merge/refund permutation test was performed. Full existing PostgreSQL integration remains blocked by the fixture issues above. Resolve those before treating this as a fully qualified production release.

## Safe cPanel/PostgreSQL rollout

These are instructions, not actions already performed. Use the existing cPanel Node.js **22** application and its existing environment. Do not initialize/seed a live database, alter production settings, or upload local SQLite/test databases. Replace the application-root placeholder with the root already shown in cPanel and activate its existing Node environment using cPanel's displayed command.

1. Review the release diff and pending migrations, including unrelated local changes. First rehearse against a restored staging copy. Resolve the legacy integration fixture failures and run the administrator checks below.
2. Announce a short maintenance window; pause the app and scheduled writers through cPanel before the snapshot/migration. Keep the previous application/build for rollback.
3. From the existing application root and Node environment, with its existing `DATABASE_URL` securely supplied:

```bash
cd /home/CPANEL_USER/EXISTING_APP_ROOT
node --version
test -n "$DATABASE_URL" || exit 1
mkdir -p "$HOME/pos-backups"
pg_dump --format=custom --file="$HOME/pos-backups/before-analytics-$(date +%Y%m%d-%H%M%S).dump" "$DATABASE_URL"
npm ci --include=dev
npm run db:plan
node scripts/db-upgrade-snapshot.mjs --output=before-analytics.json
```

4. Verify the backup is readable with `pg_restore --list BACKUP_FILE`. Stop if the migration plan contains unreviewed changes. With writes still paused, apply reviewed migrations as the schema-owning migration user (the runtime user may lack ALTER privileges):

```bash
npm run db:migrate
node scripts/db-upgrade-snapshot.mjs --output=after-analytics.json
node scripts/compare-db-snapshots.mjs before-analytics.json after-analytics.json
npm run db:plan
npm run build
```

5. Inspect that migration 074 is recorded, no migrations remain pending, existing-record snapshots agree and the production build succeeds. Leave `POS_BUILD_DIR` unset for the normal cPanel build; it is only an optional verification isolation setting. Do not use `SKIP_DB_ON_BUILD` to replace runtime database validation.
6. Restart the existing application through cPanel (startup file remains `server.js`), then run `npm run health` using the existing `APP_URL`. Follow the administrator acceptance checks. Only then resume normal writes. Map inventory master categories deliberately and grant the confidential-report permission only to appropriate staff.
7. If validation fails before reopening: keep writers paused, restore the previous application/build and restart it. Keep the additive migration/audit tables. Use the backup restore procedure only if a reviewed migration actually damaged data; never restore over new business activity without an explicit recovery decision.

## Administrator acceptance checklist

- [ ] Map inventory Meat/Vegetables to Food, packaged drinks to Beverage, and Spirits to Liquor. Set menu master categories independently. Unmapped items remain visible.
- [ ] Receive one 750 ml bottle for NPR 3,000 with base unit ml, purchase unit bottle, factor 750. Link a 30 ml menu portion with 30 ml usage. Sell one at NPR 220, with no tax/discount/refund: expected consumption NPR 120, gross profit NPR 100, remaining stock 720 ml.
- [ ] Open Purchase Analysis and drill through inventory category/SKU to the invoice; compare header tax/discount/shipping with invoice value.
- [ ] Open Sales & Recipe Cost and drill through the menu hierarchy to ingredient movements. Change the recipe or purchase price; the completed sale's recorded cost stays unchanged.
- [ ] Compare calendar-date scope with a historical assigned business day for a late purchase. Reopening a day must not duplicate transactions.
- [ ] Confirm an explicit unprepared cancellation follows stock restoration, while prepared cancellation follows existing wastage policy. Inspect the ledger references.
- [ ] Retry a keyed POS item addition with the same key and body; order quantities and stock change once. Reuse with a different body must fail.
- [ ] Check shortages and historical/unmapped sales: profit must be unavailable. Check no-stock counts and missing source journal diagnostics.
- [ ] Export Excel/CSV and print/Save as PDF with a narrowed category/date/search selection; totals and unavailable values must match the report.
- [ ] Confirm waiter/kitchen/ungranted cashier direct report/export URLs return 403; grant the new permission to an approved cashier and verify access.
