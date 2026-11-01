# KOT + BOT (kitchen and bar tickets)

One restaurant order, two production tickets. Kitchen items print on a **KOT**
(Kitchen Order Ticket), bar items on a **BOT** (Bar Order Ticket). Both belong
to the same table order and are billed, paid, stocked and posted exactly as
before: there is one bill engine and one ledger.

## How it works

| Piece | Where |
|---|---|
| Item setting: Order type **KOT — Kitchen** / **BOT — Bar** (default KOT) | Admin → Menu (form and the *Order type* column) |
| Ticket split on confirm: one KOT for kitchen lines, one BOT for bar lines, never an empty ticket | `issueKot` in `lib/kot-service.js` |
| BOT numbers `BOT-001`, `BOT-TW-001`, `BOT-D-001` from their own counter; kitchen keeps `K-…` | `lib/document-numbers.js` |
| Bar ticket = existing `kots` row with `station = 'bar'` (kitchen keeps `'main'`) | `lib/production-type.js` |
| Line snapshot `order_items.production_type`, stamped when first sent | reclassifying an item later never moves a sent line |
| ALL / KOT / BOT filter on the POS menu and the order list (view only) | `components/pos/admin-pos.jsx` |
| ALL / KOT / BOT filter on KOT history; `?type=bot` bookmarks a bar board | `app/admin/kot/page.jsx` |
| Send button follows the order-list filter: ALL = **Confirm order** (KOT + BOT), KOT = **KOT** (kitchen lines only), BOT = **BOT** (bar lines only); the other station's lines stay unsent | `components/pos/admin-pos.jsx`, `issueKot({ productionType })` |
| Reprint follows the same filter: **Reprint KOT + BOT** / **Reprint KOT** / **Reprint BOT** (latest ticket of each station) | `components/pos/admin-pos.jsx` |
| Bar ticket title / number label | Admin → Printer |
| **Where tickets print**: browser dialog, or the print helper (kitchen printer + bar printer) | Admin → Printer, `lib/print-jobs.js`, `scripts/print-helper.mjs` |
| **Print bar tickets (BOT)** switch (browser mode, on by default) | Settings → Receipt |
| Kitchen vs bar sales, ticket counts, cancelled items | Reports → Menu (shown once a bar item exists) |

Retrying a confirmation with the same idempotency key returns the same KOT and
BOT. A cancelled bar item produces a BOT cancellation notice linked to the
original BOT. Reprinting only increments `reprint_count`.

## One combined ticket (optional)

Settings → Receipt → **Combine KOT and BOT in one ticket** (`combine_kot_bot_tickets`,
off by default) returns to the single-ticket flow: every unsent line, kitchen
or bar, goes on one KOT to the kitchen station and is stamped `kot`, and the
POS hides the KOT/BOT filters and shows one "KOT" button. The switch is read
by `issueKot` on the server, so every screen follows it. Bills, VAT, service
charge, payments and stock never read it, so totals are identical in both
modes; reports file combined lines under KOT because that is the ticket that
carried them. Turning it on or off never changes tickets already sent.

## Printing

**Browser mode (default).** All tickets of one confirmation open in ONE print
window, one ticket per page (browsers block a second pop-up per click, which
used to drop the BOT). Everything goes to the printer chosen in the dialog.

**Print helper mode (two printers, no dialog).** Admin → Printer → *Where
tickets print* → *Print helper*. Set the kitchen and bar printer — by LAN IP
(`192.168.1.50`, port 9100 by default) or by Windows printer name for a USB
printer on the helper PC — save, create a helper key, and on one PC in the
restaurant run:

```
node print-helper.mjs --url https://your-site --key YOUR_HELPER_KEY
```

(`scripts/print-helper.mjs` is a single file, Node 18+, no installs.) Issuing,
reprinting and cancelling then queue a job per ticket (`print_jobs`, migration
076); the helper prints the KOT and BOT side by side, each on its own printer,
as ESC/POS with a cut. A station with no printer set holds its tickets (never
the other printer). Failed prints retry 5 times, then show as *failed* with the
reason and a Retry button; the POS warns by ticket number if a ticket has not
printed 15 seconds later. "Printed" means the printer accepted the data — a
printer cannot report that paper came out.

## Reporting

One calculation, `lib/production-sales.js`, feeds every kitchen/bar figure.
Each screen passes the bills and refunds it ALREADY uses for its own total;
every amount a bill carries (grand total, discount, VAT, service charge,
delivery fee, later refunds) is split across that bill's own sold lines by
line value, in whole paisa (largest remainder). So on every screen
**KOT + BOT + Other = that screen's total, exactly**. Nothing is recalculated
and nothing is written.

* A sold line's station is its persisted snapshot (`order_items.production_type`);
  lines sold before KOT/BOT existed use the ticket that carried them (all
  kitchen). Today's menu setting is never read, so reclassifying an item never
  rewrites past reports.
* **Other** = delivery fees, bills with no sold lines, and lines never sent to
  the kitchen or bar — shown, not guessed.
* A refund is split by the mix of the bill it refunds.
* Rs 0 settled bills count as *complimentary quantity*, never revenue.
* Ticket counts and cancelled items are production counts, never money.

| Where | What |
|---|---|
| Dashboard | Today's sales split (open business day) |
| Business day / closing report | KOT / BOT / Other table under the sales summary |
| Analytics → Overview | Contribution bar, top kitchen and top bar items |
| Analytics → Sales & Money | Kitchen vs bar sales per day |
| Reports → Overview | KOT / BOT / Other net per day + Kitchen vs bar table |
| Reports → Sales | Kitchen vs bar table (gross, discount, tax, service, refunds, net, net excl. tax, tickets, cancelled, complimentary) + split per day |
| Reports → Menu, Categories | **ALL / KOT / BOT filter** on item lines; Station column; category KOT/BOT columns |
| Reports → Employees | Revenue served split into kitchen / bar per waiter |

The ALL / KOT / BOT filter binds only to item-line reports. Bill-level totals
(payments, cash, tax returns, receivables) are not filtered by station: a bill
holding both cannot be filtered without allocating it, so those tabs show the
split as a table instead. Exports use the same query, so a BOT-filtered screen
exports BOT rows. Purchases, stock and cost reports are not split: purchases
are not traceable to a station.

## What it never touches

Prices, tax, discounts, service charge, payments, journals, stock deduction
timing (still at add-item time), recipes, wastage rules and business-day close.
Sales per station come from the same paid-bill lines as item sales, so KOT +
BOT always equals the item total.

## Activation

Nothing changes until an item is set to **BOT**. Until then the POS shows no
KOT/BOT controls and every ticket is a KOT, exactly as before.

1. Back up the database.
2. `npm run db:migrate` (applies `075_kot_bot_production_type.sql`: two
   nullable/defaulted columns and one index; and `076_print_jobs.sql`: the
   print queue table; and `077_kot_bot_reporting_index.sql`: one index for
   reporting. No data rewritten).
3. Deploy the app.
4. For two printers, set up the print helper (see *Printing*) and use
   Admin → Printer → *Test print* for each printer. With one printer, leave
   browser mode; turn off **Settings → Receipt → Print bar tickets (BOT)** only
   if that device must never print bar tickets.
5. Mark bar items as **BOT — Bar** in Admin → Menu (per item; a category is
   not assumed — tea can stay KOT while water is BOT).

## Rollback

Set every item back to KOT (`UPDATE menu_items SET production_type = 'kot'`)
and the app behaves as before; already-issued BOTs stay in history. Rolling
back the code is safe with the columns left in place; they are ignored by the
previous release. Do not drop the columns while BOT history should be kept.

## Known limits

- **Billing one station at a time is not supported.** The billing engine
  issues one bill per order covering all its lines. The order-list filter only
  views kitchen or bar lines with their subtotals; it does not bill a subset. A
  second split-bill engine was deliberately not added.
- Browser mode reaches one printer (the one chosen in the dialog). Separate
  kitchen and bar printers need the print helper running on a restaurant PC;
  if it is not running, tickets wait in the queue and the POS warns.
- Combo packs print on the kitchen ticket.
- Lines billed without ever being sent on a ticket count as KOT in the report.
