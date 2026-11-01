/**
 * Print helper end to end: the real POS routes on PostgreSQL, the real
 * scripts/print-helper.mjs process, and two fake network thermal printers.
 *
 * "Confirm order & Print" must put the KOT on the kitchen printer and the BOT
 * on the bar printer at the same time; "BOT & Print" must reach the bar
 * printer only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from '../../lib/db/index.js';
import { AuthService } from '../../lib/auth/auth.js';
import { openBusinessDay } from '../../lib/business-days.js';
import { nepalDateString } from '../../lib/report-dates.js';
import { listPrintJobs } from '../../lib/print-jobs.js';
import { POST as createOrder } from '../../app/api/admin/pos/orders/route.js';
import { POST as addItems } from '../../app/api/admin/pos/orders/[id]/items/route.js';
import { POST as issueTickets } from '../../app/api/admin/pos/orders/[id]/kot/route.js';
import { POST as createHelperKey } from '../../app/api/admin/print-jobs/helper-key/route.js';
import { GET as helperPoll } from '../../app/api/print-helper/jobs/route.js';
import { POST as helperReport } from '../../app/api/print-helper/jobs/[id]/route.js';

if (!/^\/km_test_\d+_\d+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw Error('Use scripts/run-integration.mjs to isolate this mutating test.');

const db = Database.getInstance();
const admin = { id: 1, role: 'admin', full_name: 'Test Admin' };
const realVerify = AuthService.prototype.verifySession;
const cleanup = [];
test.after(async () => {
  AuthService.prototype.verifySession = realVerify;
  for (const fn of cleanup.reverse()) await fn();
  await Database.close();
});

const post = (handler, url, body, id) => handler(
  new Request(`http://localhost${url}`, { method: 'POST', headers: { authorization: 'Bearer contract' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: String(id) }) }
);
async function ok(responsePromise) {
  const response = await responsePromise;
  const body = await response.json();
  assert.ok(response.status < 300, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}
async function setSetting(key, value) {
  await db.run(
    `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [key, value]
  );
}

/** A thermal printer on the LAN: accepts raw bytes on a TCP port. */
async function fakePrinter() {
  const received = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push({ at: Date.now(), text: Buffer.concat(chunks).toString('latin1') }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { received, address: `127.0.0.1:${server.address().port}` };
}

/** Serves only the two print-helper endpoints, through the real route handlers. */
async function helperApi() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    const match = req.url.match(/^\/api\/print-helper\/jobs\/(\d+)$/);
    const response = match
      ? await helperReport(request, { params: Promise.resolve({ id: match[1] }) })
      : await helperPoll(request);
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(await response.text());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(check, what, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('Confirm order & Print: KOT on the kitchen printer and BOT on the bar printer together', async () => {
  AuthService.prototype.verifySession = async () => admin;
  await openBusinessDay(db, { business_date: nepalDateString(), opening_cash: 0 }, admin);
  const category = (await db.run(`INSERT INTO menu_categories (name, display_order) VALUES ('PH Contract', 99)`)).lastInsertRowid;
  const menu = {};
  for (const [key, name, type] of [['momo', 'PH Chicken Momo', 'kot'], ['beer', 'PH Gorkha Beer', 'bot']]) {
    menu[key] = (await db.run(
      `INSERT INTO menu_items (name, category_id, base_price, is_available, production_type) VALUES (?, ?, 300, 1, ?)`,
      [name, category, type]
    )).lastInsertRowid;
  }

  const kitchen = await fakePrinter();
  const bar = await fakePrinter();
  await setSetting('print_mode', 'helper');
  await setSetting('kitchen_printer_connection', 'network');
  await setSetting('kitchen_printer_target', kitchen.address);
  await setSetting('bar_printer_connection', 'network');
  await setSetting('bar_printer_target', bar.address);

  const { key } = await ok(post(createHelperKey, '/api/admin/print-jobs/helper-key', {}, ''));
  const url = await helperApi();
  const helper = spawn(process.execPath, ['scripts/print-helper.mjs', '--url', url, '--key', key], { stdio: ['ignore', 'pipe', 'pipe'] });
  let helperLog = '';
  helper.stdout.on('data', (d) => { helperLog += d; });
  helper.stderr.on('data', (d) => { helperLog += d; });
  cleanup.push(() => helper.kill());

  // Confirm order & Print (ALL).
  const created = await ok(post(createOrder, '/api/admin/pos/orders', { order_type: 'takeaway' }, ''));
  const orderId = created.workspace?.order?.order_id || created.workspace?.order?.id || created.order_id;
  await ok(post(addItems, `/api/admin/pos/orders/${orderId}/items`, {
    idempotency_key: 'ph-add-1', items: [{ menu_item_id: menu.momo, quantity: 2 }, { menu_item_id: menu.beer, quantity: 1 }],
  }, orderId));
  const issued = await ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, { idempotency_key: 'ph-1', print: true }, orderId));
  assert.equal(issued.print.mode, 'helper');
  assert.deepEqual(issued.print.queued.map((j) => j.station), ['main', 'bar']);

  await waitFor(async () => kitchen.received.length >= 1 && bar.received.length >= 1, `both printers (helper log: ${helperLog})`);
  const [kot] = kitchen.received;
  const [bot] = bar.received;
  assert.match(kot.text, /KITCHEN ORDER TICKET/);
  assert.match(kot.text, /PH Chicken Momo/);
  assert.doesNotMatch(kot.text, /PH Gorkha Beer/);
  assert.match(bot.text, /BAR ORDER TICKET/);
  assert.match(bot.text, /PH Gorkha Beer/);
  assert.doesNotMatch(bot.text, /PH Chicken Momo/);
  assert.ok(Math.abs(kot.at - bot.at) < 3000, `printed together (${Math.abs(kot.at - bot.at)} ms apart)`);
  assert.ok(kot.text.endsWith('\x1dVB\x00'), 'the ticket is cut');

  await waitFor(async () => (await listPrintJobs(db, { ids: issued.print.queued.map((j) => j.id) }))
    .every((j) => j.status === 'done'), 'jobs reported printed');

  // A retried confirmation prints nothing again.
  const retried = await ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, { idempotency_key: 'ph-1', print: true }, orderId));
  assert.equal(retried.idempotent, true);

  // BOT & Print: only the bar printer.
  await ok(post(addItems, `/api/admin/pos/orders/${orderId}/items`, {
    idempotency_key: 'ph-add-2', items: [{ menu_item_id: menu.momo, quantity: 1 }, { menu_item_id: menu.beer, quantity: 2 }],
  }, orderId));
  const barOnly = await ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, {
    idempotency_key: 'ph-2', print: true, production_type: 'bot',
  }, orderId));
  assert.deepEqual(barOnly.kots.map((k) => k.station), ['bar']);
  await waitFor(async () => bar.received.length >= 2, 'the second bar ticket');
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(bar.received.length, 2);
  assert.equal(kitchen.received.length, 1, 'BOT & Print sends nothing to the kitchen printer');
  assert.match(bar.received[1].text, /ADDITIONAL/);

  // KOT & Print later sends the waiting kitchen line to the kitchen only.
  await ok(post(issueTickets, `/api/admin/pos/orders/${orderId}/kot`, { idempotency_key: 'ph-3', print: true, production_type: 'kot' }, orderId));
  await waitFor(async () => kitchen.received.length >= 2, 'the second kitchen ticket');
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(bar.received.length, 2, 'KOT & Print sends nothing to the bar printer');
});
