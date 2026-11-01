import { test, expect } from '@playwright/test';
import { isoToBsDisplay } from '../../lib/date-input-model.js';

test('owner analysis: report modes, hierarchy, exports and responsive layout', async ({ page, request }) => {
  test.setTimeout(120_000);
  const login = await request.post('/api/auth/login', { data: { username: process.env.E2E_ADMIN_USER || 'admin', pin: process.env.E2E_ADMIN_PIN || '123456' } });
  expect(login.ok()).toBeTruthy();
  const auth = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('pos_token', token); localStorage.setItem('pos_user', JSON.stringify(user));
  }, { token: auth.token, user: auth.user });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [route, heading] of [['purchase-vs-sales', 'Purchase vs Sales Analysis'], ['purchase-analysis', 'Purchase Analysis'], ['sales-recipe-cost', 'Sales & Recipe Cost'], ['inventory-consumption', 'Inventory Consumption']]) {
    const response = page.waitForResponse((r) => r.url().includes('/api/admin/purchase-sales-analysis?') && r.request().method() === 'GET');
    await page.goto(`/admin/${route}`);
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading recorded transactions…' })).toHaveCount(0);
    await expect(page.getByRole('table').first()).toBeVisible();
    await expect(page.getByText('How to read this report')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow, `overflow on ${route}`).toBeFalsy();
  }
  await page.goto('/admin/purchase-analysis');
  await expect(page.getByRole('table').first()).toBeVisible();
  const first = page.locator('tbody tr td button:visible, main section > button:visible').first();
  if (await first.count()) {
    await first.click();
    await expect(page.getByRole('combobox', { name: 'Group by', exact: true })).toHaveValue('item');
  }
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('purchases-analysis.xls');
  expect(errors).toEqual([]);
});

test('80mm printing isolates the report and keeps all financial lines readable', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { username: process.env.E2E_ADMIN_USER || 'admin', pin: process.env.E2E_ADMIN_PIN || '123456' } });
  expect(login.ok()).toBeTruthy();
  const auth = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('pos_token', token); localStorage.setItem('pos_user', JSON.stringify(user));
    // Avoid a physical print job while validating the exact document sent to print.
    Window.prototype.print = function () { this.__reportPrintCalled = true; };
  }, { token: auth.token, user: auth.user });
  await page.goto('/admin/purchase-vs-sales');
  await expect(page.getByRole('table').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show charts', exact: true })).toHaveCount(0);
  await expect(page.locator('svg.recharts-surface')).toHaveCount(0);
  const fullReport = page.waitForResponse((response) => response.url().includes('/api/admin/purchase-sales-analysis?') && new URL(response.url()).searchParams.get('export') === '1');
  await page.getByRole('button', { name: 'Print 80mm', exact: true }).click();
  const printData = await (await fullReport).json();
  expect(printData.pagination?.exported ?? printData.mode === 'combined').toBeTruthy();
  const frame = page.frameLocator('iframe[data-analysis-print="true"]');
  await expect(frame.getByRole('heading', { name: 'Purchase & Sales Report' })).toBeAttached();
  await expect(frame.locator('nav, aside, svg, button, table')).toHaveCount(0);
  await expect(frame.getByText('End of report', { exact: false })).toBeAttached();
  await expect(frame.getByRole('heading', { level: 2 })).toHaveCount(printData.rows.length + 1);
  const width = await frame.locator('body').evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(270); expect(width).toBeLessThan(274);
  const overflow = await frame.locator('body').evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(overflow).toBeFalsy();
});

test('category and custom dates apply to the table, exports and report-only print', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { username: process.env.E2E_ADMIN_USER || 'admin', pin: process.env.E2E_ADMIN_PIN || '123456' } });
  const auth = await login.json();
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('pos_token', token); localStorage.setItem('pos_user', JSON.stringify(user));
    Window.prototype.print = function () {};
  }, { token: auth.token, user: auth.user });
  await page.goto('/admin/purchase-analysis');
  await expect(page.getByRole('table').first()).toBeVisible();
  const category = page.getByRole('combobox', { name: 'Category', exact: true });
  const option = await category.locator('option').evaluateAll((options) => options.find((o) => o.textContent.includes('[DEMO]'))?.value || options.find((o) => o.value && o.value !== '0')?.value);
  expect(option).toBeTruthy();
  await category.selectOption(option);
  await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('item');
  await page.getByRole('combobox', { name: 'Period', exact: true }).selectOption('custom');
  const tableResponse = page.waitForResponse((r) => { const q = new URL(r.url()).searchParams; return r.url().includes('/api/admin/purchase-sales-analysis?') && q.get('startDate') === '2026-10-23' && q.get('endDate') === '2026-10-25' && !q.get('export'); });
  const isBs = (await page.getByRole('textbox', { name: 'Start date', exact: true }).getAttribute('placeholder')).includes('BS');
  await page.getByRole('textbox', { name: 'Start date', exact: true }).fill(isBs ? isoToBsDisplay('2026-10-23') : '23/10/2026');
  await page.getByRole('textbox', { name: 'End date', exact: true }).fill(isBs ? isoToBsDisplay('2026-10-25') : '25/10/2026');
  await page.getByRole('textbox', { name: 'End date', exact: true }).press('Tab');
  const data = await (await tableResponse).json();
  expect(data.filters.categoryId).toBe(Number(option));
  await expect(page.getByRole('table').first()).toBeVisible();
  const printResponse = page.waitForResponse((r) => r.url().includes('/api/admin/purchase-sales-analysis?') && new URL(r.url()).searchParams.get('export') === '1');
  await page.getByRole('button', { name: 'Print 80mm', exact: true }).click();
  const printed = await (await printResponse).json();
  expect(printed.filters.categoryId).toBe(Number(option));
  expect(printed.range.start).toBe('2026-10-23'); expect(printed.range.end).toBe('2026-10-25');
  expect(printed.totals).toEqual(data.totals);
  const frame = page.frameLocator('iframe[data-analysis-print="true"]');
  await expect(frame.getByRole('heading', { name: 'Purchase Report', exact: true })).toBeAttached();
  for (const row of printed.rows) await expect(frame.getByRole('heading', { name: row.name, exact: true })).toBeAttached();
  await expect(frame.locator('nav, aside, button')).toHaveCount(0);
  const exportRequest = page.waitForRequest((r) => r.url().includes('/api/admin/purchase-sales-analysis?') && new URL(r.url()).searchParams.get('format') === 'csv');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const exportQuery = new URL((await exportRequest).url()).searchParams;
  expect(exportQuery.get('categoryId')).toBe(option); expect(exportQuery.get('startDate')).toBe('2026-10-23'); expect(exportQuery.get('endDate')).toBe('2026-10-25');
  await download;
});
