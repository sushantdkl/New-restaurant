'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Printer, RefreshCw, X } from 'lucide-react';
import AdminLayout from '@/components/admin/admin-layout';
import DateInput from '@/components/ui/date-input.jsx';
import { apiJson, authedRequest } from '@/lib/authed-fetch';
import { useCapabilities } from '@/lib/use-capabilities.js';
import { useCalendarSystem } from '@/lib/calendar-context.jsx';
import { nepalDateString } from '@/lib/report-dates';
import { foodGroupLabel, normalizeFoodGroup } from '@/lib/food-groups';
import { loadPrintSettings } from '@/lib/print-report.js';
import { simpleAnalysisColumns, ANALYSIS_DESCRIPTIONS, analysisValueIsPartial } from '@/lib/analysis-presentation.js';
import { buildAnalysisPrintHtml, printAnalysisHtml } from '@/lib/analysis-print.js';

const MODES = { combined: 'Purchase vs Sales Analysis', purchases: 'Purchase Analysis', sales: 'Sales & Recipe Cost', inventory: 'Inventory Consumption' };
const ROUTES = { combined: 'purchase-vs-sales', purchases: 'purchase-analysis', sales: 'sales-recipe-cost', inventory: 'inventory-consumption' };
const control = 'max-w-full h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm';
const money = (value) => value == null ? '—' : `Rs ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quantity = (value) => value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 4 });

export default function PurchaseSalesAnalysis({ initialMode = 'combined' }) {
  const { can, loading: permissionsLoading } = useCapabilities();
  const { calendarSystem } = useCalendarSystem();
  const pathname = usePathname();
  const query = useSearchParams();
  const base = pathname?.startsWith('/cashier') ? '/cashier' : '/admin';
  const mode = initialMode;
  const [level, setLevel] = useState(initialMode === 'combined' && !query.get('master') ? 'master' : 'category');
  const [master, setMaster] = useState(query.get('master') ? normalizeFoodGroup(query.get('master')) : '');
  const [category, setCategory] = useState(null);
  const [period, setPeriod] = useState(query.get('period') || 'today');
  const [start, setStart] = useState(query.get('startDate') || nepalDateString());
  const [end, setEnd] = useState(query.get('endDate') || nepalDateString());
  const [day, setDay] = useState(query.get('businessDayId') || '');
  const [supplier, setSupplier] = useState('');
  const [search, setSearch] = useState(query.get('search') || '');
  const [sort, setSort] = useState('name');
  const [direction, setDirection] = useState('asc');
  const [page, setPage] = useState(1);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailPage, setDetailPage] = useState(1);
  const [detailError, setDetailError] = useState('');
  const [printing, setPrinting] = useState(false);
  const requestId = useRef(0);
  const allowed = can('report.profitability.view');

  const params = useCallback(() => {
    const q = new URLSearchParams({ mode, level, period, calendarSystem, page: String(page), page_size: '50', sort, dir: direction, charts: '0' });
    if (period === 'custom') { q.set('startDate', start); q.set('endDate', end); }
    if (master) q.set('master', master);
    if (category) q.set('categoryId', category.id);
    if (day) q.set('businessDayId', day);
    if (supplier && mode === 'purchases') q.set('supplierId', supplier);
    if (search) q.set('search', search);
    return q;
  }, [mode, level, period, calendarSystem, page, sort, direction, start, end, master, category, day, supplier, search]);

  const load = useCallback(async () => {
    if (!allowed) return;
    const id = ++requestId.current;
    setLoading(true); setError(''); setDetail(null);
    try {
      const data = await apiJson(`/api/admin/purchase-sales-analysis?${params()}`);
      if (id === requestId.current) setReport(data);
    } catch (e) { if (id === requestId.current) { setError(e.error || e.message || 'Could not load analysis.'); setReport(null); } }
    finally { if (id === requestId.current) setLoading(false); }
  }, [params, allowed]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    setDetailData(null); setDetailError('');
    const q = params(); q.set('itemId', detail.id); q.set('detail', '1'); q.set('page', String(detailPage));
    apiJson(`/api/admin/purchase-sales-analysis?${q}`).then((data) => { if (!cancelled) setDetailData(data); })
      .catch((e) => { if (!cancelled) setDetailError(e.error || 'Could not load item details.'); });
    return () => { cancelled = true; };
  }, [detail, detailPage, params]);

  const drill = (row) => {
    setPage(1);
    if (mode === 'combined') { if (level === 'master') { setMaster(row.master); setLevel('category'); } return; }
    if (level === 'master') { setMaster(row.master); setLevel('category'); }
    else if (level === 'category') { setCategory(row); setLevel('item'); }
    else if (mode !== 'inventory') { setDetail(row); setDetailPage(1); }
  };
  const exportFile = async (format) => {
    try {
      const q = params(); q.set('format', format);
      const response = await authedRequest(`/api/admin/purchase-sales-analysis?${q}`);
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `${mode}-analysis.${format}`; link.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e.message || 'Export failed.'); }
  };
  const print = async (size = '80') => {
    setPrinting(true);
    try {
      const q = params(); q.set('export', '1'); q.set('charts', '0');
      const [data, settings] = await Promise.all([apiJson(`/api/admin/purchase-sales-analysis?${q}`), loadPrintSettings()]);
      const scope = [master ? foodGroupLabel(master) : '', category?.name, supplier ? report?.suppliers?.find((s) => String(s.id) === supplier)?.name : '', search ? `Search: ${search}` : ''].filter(Boolean).join(' / ');
      printAnalysisHtml(buildAnalysisPrintHtml(data, { size, restaurantName: settings.restaurant_name, scope }));
    } catch (e) { setError(e.error || 'Could not prepare print report.'); }
    finally { setPrinting(false); }
  };
  const visible = report;
  const sharedScope = params();
  for (const key of ['mode', 'level', 'categoryId', 'supplierId', 'search', 'page', 'page_size', 'sort', 'dir', 'charts']) sharedScope.delete(key);
  const cols = simpleAnalysisColumns(mode, level);
  const totals = visible?.totals;
  const masterGroups = [...(report?.masterGroups || [])];
  if (master && !masterGroups.some((group) => group.id === master)) masterGroups.push({ id: master, label: foodGroupLabel(master) });
  const displayValue = (column, value) => column.money ? money(value) : value == null ? '—' : column.percent || column.key === 'gross_margin' ? `${quantity(value)}%` : typeof value === 'number' ? quantity(value) : value;
  const table = (rows, totalsRow = false) => rows.map((row) => <tr key={totalsRow ? 'total' : row.id} className={totalsRow ? 'bg-gray-100 font-semibold' : 'border-t hover:bg-gray-50'}>
    {cols.map((col, i) => <td key={col.key} className={`px-4 py-3 [overflow-wrap:normal] ${i ? 'text-right tabular-nums' : 'text-left'} whitespace-nowrap`}>
      {i === 0 ? totalsRow ? 'TOTAL' : <>{mode === 'combined' && level === 'category' ? <span className="font-medium">{row.name}</span> : <button onClick={() => drill(row)} className="font-medium text-teal-800 underline underline-offset-4">{level === 'master' ? foodGroupLabel(row.name) : row.name}</button>}</>
        : <>{displayValue(col, row[col.key])}{analysisValueIsPartial(row, col.key) && <span className="ml-1 text-xs text-amber-800">(partial)</span>}</>}
    </td>)}
  </tr>);

  return <AdminLayout><main className="mx-auto max-w-screen-2xl space-y-4 p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl"><h1 className="mt-1 text-2xl font-bold text-gray-900">{MODES[mode]}</h1><p className="mt-2 text-sm text-gray-600">{ANALYSIS_DESCRIPTIONS[mode]}</p></div>
      {allowed && <div className="flex flex-wrap gap-2 print:hidden"><button className={control} onClick={() => exportFile('xls')} disabled={loading || !report}><Download className="mr-1 inline h-4 w-4" />Excel</button><button className={control} onClick={() => exportFile('csv')} disabled={loading || !report}>CSV</button><button className="h-10 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white disabled:opacity-50" onClick={() => print('80')} disabled={printing || loading || !report}><Printer className="mr-2 inline h-4 w-4" />{printing ? 'Preparing…' : 'Print 80mm'}</button><button className={control} onClick={() => print('a4')} disabled={printing || loading || !report}>A4 / PDF</button></div>}
    </div>
    {permissionsLoading ? <p role="status">Checking access…</p> : !allowed ? <p role="alert" className="rounded-xl border p-6">You do not have permission to view confidential purchase and profitability analytics.</p> : <>
      <nav aria-label="Purchase and inventory reports" className="flex flex-wrap gap-2 print:hidden">{Object.entries(MODES).map(([key, label]) => <Link key={key} href={`${base}/${ROUTES[key]}?${sharedScope}`} aria-current={mode === key ? 'page' : undefined} className={`rounded-lg border px-3 py-2 text-sm ${mode === key ? 'border-teal-700 bg-teal-50 font-semibold text-teal-900' : 'border-gray-200 text-gray-700'}`}>{label}</Link>)}</nav>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-200 bg-white p-3 print:hidden">
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm sm:block">Period<select className={`${control} sm:ml-2`} value={period} onChange={(e) => { setPeriod(e.target.value); setDay(''); setPage(1); }}><option value="today">Today / open business day</option><option value="yesterday">Yesterday</option><option value="last3">Last 3 days</option><option value="last7">Last 7 days</option><option value="last30">Last 30 days</option><option value="this_week">This week</option><option value="this_month">This month</option><option value="last_month">Last month</option><option value="quarter">This quarter</option><option value="year">This year</option><option value="custom">Custom dates</option></select></label>
        <button type="button" aria-pressed={period === 'custom'} className={`${control} ${period === 'custom' ? 'border-teal-700 bg-teal-50 font-semibold text-teal-900' : ''}`} onClick={() => { setPeriod('custom'); setDay(''); setPage(1); }}>Custom dates</button>
        {period === 'custom' && <div className="flex max-w-full flex-wrap items-end gap-2" role="group" aria-label="Custom date range">
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">From<DateInput aria-label="Start date" value={start} onChange={(value) => { setStart(value); setDay(''); setPage(1); }} className={control} /></label>
          <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm">To<DateInput aria-label="End date" value={end} onChange={(value) => { setEnd(value); setDay(''); setPage(1); }} className={control} /></label>
        </div>}
        <select aria-label={mode === 'combined' ? 'Category' : 'Master category'} className={control} value={master} onChange={(e) => { setMaster(e.target.value); setCategory(null); if (mode === 'combined') setLevel(e.target.value ? 'category' : 'master'); setPage(1); }}><option value="">{mode === 'combined' ? 'All categories' : 'All master categories'}</option>{masterGroups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select>
        {mode !== 'combined' && <>
          <select aria-label="Category" className={`${control} max-w-64`} value={category?.id ?? ''} onChange={(e) => { const id = e.target.value; setCategory(id === '' ? null : [...(report?.categories || []), { id: 0, name: 'Uncategorised' }].find((c) => String(c.id) === id)); setLevel(id === '' ? 'category' : 'item'); setPage(1); }}><option value="">All categories</option>{[...(report?.categories || []), { id: 0, name: 'Uncategorised', master: 'uncategorised' }].filter((c) => !master || c.master === master || c.masters?.includes(master) || (c.id === 0 && mode !== 'sales')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select aria-label="Group by" className={control} value={level} onChange={(e) => { setLevel(e.target.value); setPage(1); }}><option value="master">By master category</option><option value="category">By category</option><option value="item">By item</option></select>
        </>}
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm sm:block">Business day<select className={`${control} sm:ml-2`} value={day} onChange={(e) => { setDay(e.target.value); setPage(1); }}><option value="">Automatic / transaction date</option>{report?.businessDays?.map((d) => <option key={d.id} value={d.id}>{d.opening_note?.includes('[DEMO]') ? 'Demo · ' : ''}{String(d.business_date).slice(0, 10)} · {d.status}</option>)}</select></label>
        {mode === 'purchases' && <label className="flex min-w-0 max-w-full flex-col gap-1 text-sm sm:block">Supplier<select className={`${control} sm:ml-2`} value={supplier} onChange={(e) => { setSupplier(e.target.value); setPage(1); }}><option value="">All suppliers</option>{report?.suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        <input className={control} placeholder="Search item name…" aria-label="Search items" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <button className={control} onClick={() => { setPeriod('today'); setDay(''); setMaster(''); setCategory(null); setSupplier(''); setSearch(''); setLevel(mode === 'combined' ? 'master' : 'category'); setPage(1); }}><RefreshCw className="mr-1 inline h-4 w-4" />Reset</button>
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-800">{error}</p>}
      {loading && <p role="status">Loading recorded transactions…</p>}
      {visible && !loading && <>
        <p className="text-sm text-gray-600">{visible.range.label} · NPR{master ? ` · ${foodGroupLabel(master)}` : ''}{category ? ` / ${category.name}` : ''}{supplier ? ` · Supplier #${supplier}` : ''}{search ? ` · Search: ${search}` : ''}</p>
        {mode === 'combined' && master && <button type="button" className={`${control} print:hidden`} onClick={() => { setMaster(''); setCategory(null); setLevel('master'); setPage(1); }}><ArrowLeft className="mr-2 inline h-4 w-4" />Back to all categories</button>}
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white"><table className="w-full text-sm"><thead className="bg-gray-50 text-gray-600"><tr>{cols.map((c, i) => <th key={c.key} className={`px-4 py-3 [overflow-wrap:normal] ${i ? 'text-right' : 'text-left'}`}><button disabled={!c.sort} onClick={() => { setSort(c.sort); setDirection(sort === c.sort && direction === 'asc' ? 'desc' : 'asc'); setPage(1); }}>{c.label}{sort === c.sort ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead><tbody>{table(visible.rows)}{totals && table([totals], true)}</tbody></table>{!visible.rows.length && <p className="p-8 text-center text-gray-500">No transactions match these filters.</p>}</div>
        {visible.pagination?.total_pages > 1 && <div className="flex items-center justify-between text-sm print:hidden"><span>{visible.pagination.total} groups · Page {page} of {visible.pagination.total_pages}</span><div className="flex gap-2"><button className={control} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className={control} disabled={!visible.pagination.has_more} onClick={() => setPage(page + 1)}>Next</button></div></div>}
      </>}
      {detail && <section className="rounded-xl border-2 border-teal-200 bg-white p-5 print:hidden" aria-label="Item transaction details"><div className="flex justify-between gap-3"><h2 className="text-lg font-semibold">{detail.name} · Transaction detail</h2><button onClick={() => setDetail(null)} aria-label="Close item details"><X className="h-5 w-5" /></button></div>
        {detailError ? <p role="alert">{detailError}</p> : !detailData ? <p role="status">Loading item history…</p> : <>
          <div className="mt-4 overflow-auto"><table className="w-full text-sm"><thead><tr>{(mode === 'purchases' ? ['Purchase reference', 'Supplier', 'Invoice date', 'Quantity', 'Unit price', 'Line value'] : ['Order / movement', 'Ingredient', 'Quantity requested', 'Recorded deduction / restoration', 'Unit cost', 'Recipe / costing snapshot']).map((c) => <th key={c} className="px-3 py-2 text-left">{c}</th>)}</tr></thead><tbody>{detailData.rows.map((r) => <tr key={r.id} className="border-t">{mode === 'purchases' ? <><td className="p-3"><Link className="text-teal-800 underline" href={`${base}/purchases?purchase=${r.purchase_id}`}>{r.invoice_number || `Purchase #${r.purchase_id}`}</Link></td><td>{r.supplier}</td><td>{r.invoice_date}</td><td>{quantity(r.quantity_received)}</td><td>{money(r.unit_cost)}</td><td>{money(r.line_total)}</td></> : <><td className="p-3"><Link href={`${base}/orders/${r.reference_id}`} className="text-teal-800 underline">Order #{r.reference_id}</Link> / #{r.id}</td><td>{r.ingredient}</td><td>{quantity(r.quantity_requested)} {r.unit}</td><td>{quantity(r.quantity_changed)} {r.unit}</td><td>{money(r.unit_cost)}</td><td className="max-w-sm break-words p-3 text-xs">{r.recipe_snapshot} · {r.cost_status}</td></>}</tr>)}</tbody></table>{!detailData.rows.length && <p className="py-5">No attributed movement history is available for this selection. Historical costs are unavailable.</p>}</div>
          <div className="mt-4 flex gap-2"><button className={control} disabled={detailPage === 1} onClick={() => setDetailPage(detailPage - 1)}>Previous</button><span className="p-2">Page {detailPage} / {detailData.pagination.total_pages}</span><button className={control} disabled={!detailData.pagination.has_more} onClick={() => setDetailPage(detailPage + 1)}>Next</button></div>
          {detailData.currentRecipe && <div className="mt-5 border-t pt-4"><h3 className="font-semibold">Current recipe preview · version {detailData.currentRecipe.version}</h3><p className="text-sm text-gray-600">{detailData.currentRecipe.basis}</p><ul className="mt-2 text-sm">{detailData.currentRecipe.cost.breakdown.map((r) => <li key={r.inventory_item_id}>{r.item_name} · {quantity(r.quantity)} {r.unit} per {detailData.currentRecipe.yield_quantity} serving(s) · {money(r.line_cost)}</li>)}</ul><Link href={`${base}/recipes/${detailData.currentRecipe.id}`} className="mt-2 inline-block text-sm text-teal-800 underline">Open recipe</Link></div>}
        </>}
      </section>}
    </>}
  </main></AdminLayout>;
}
