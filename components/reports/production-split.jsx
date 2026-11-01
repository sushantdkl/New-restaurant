'use client';

import { Bar, BarChart as RcBarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCurrency } from '@/lib/currency';

/**
 * Kitchen (KOT) / Bar (BOT) share of a sales figure — one compact strip used by
 * the dashboard, business-day summary and analytics. `split` is the
 * `{ rows, total }` shape from lib/production-sales.js; the amounts are the
 * caller's own net sales, so the parts always add up to the total shown.
 */
export const PRODUCTION_COLORS = { kot: '#f59e0b', bot: '#6366f1', other: '#94a3b8' };
const NAMES = { kot: 'Kitchen (KOT)', bot: 'Bar (BOT)', other: 'Other' };

export default function ProductionSplit({ split, title = 'Sales by station', field = 'net_sales', note = null, className = '' }) {
  if (!split?.rows) return null;
  const rows = split.rows.filter((r) => r.production_type !== 'other' || Math.abs(Number(r[field] || 0)) >= 0.01);
  const total = Number(split.total?.[field] || 0);
  const pct = (value) => (total ? Math.round((Number(value || 0) / total) * 1000) / 10 : 0);
  return (
    <div className={`rounded-2xl border border-gray-200 bg-white p-4 shadow-sm ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        <p className="text-xs text-gray-500 tabular-nums">Total {formatCurrency(total)}</p>
      </div>
      <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100" role="img" aria-label={rows.map((r) => `${NAMES[r.production_type]} ${pct(r[field])}%`).join(', ')}>
        {rows.map((r) => (
          <span key={r.production_type} style={{ width: `${Math.max(0, pct(r[field]))}%`, background: PRODUCTION_COLORS[r.production_type] }} />
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.production_type} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-medium text-gray-600">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PRODUCTION_COLORS[r.production_type] }} />
              {NAMES[r.production_type]}
            </span>
            <span className="text-right">
              <span className="block text-sm font-semibold tabular-nums text-gray-900">{formatCurrency(r[field] || 0)}</span>
              <span className="block text-[11px] tabular-nums text-gray-400">{pct(r[field])}%</span>
            </span>
          </div>
        ))}
      </div>
      {note && <p className="mt-2 text-[11px] text-gray-400">{note}</p>}
    </div>
  );
}

/** Net sales per day stacked by station. `trend` rows: { label, kot, bot, other }. */
export function ProductionTrend({ trend = [], height = 220 }) {
  const showOther = trend.some((d) => Math.abs(Number(d.other || 0)) >= 0.01);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RcBarChart data={trend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid stroke="#f3f4f6" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false} minTickGap={12} />
        <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={64} />
        <Tooltip formatter={(value, key) => [formatCurrency(value), NAMES[key] || key]} />
        <Legend formatter={(key) => NAMES[key] || key} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="kot" stackId="s" fill={PRODUCTION_COLORS.kot} />
        <Bar dataKey="bot" stackId="s" fill={PRODUCTION_COLORS.bot} />
        {showOther && <Bar dataKey="other" stackId="s" fill={PRODUCTION_COLORS.other} />}
      </RcBarChart>
    </ResponsiveContainer>
  );
}

/** Top sellers for one station: [{ name, quantity, revenue }]. */
export function StationTopItems({ type, rows = [] }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: PRODUCTION_COLORS[type] }} />
        Top {type === 'bot' ? 'bar' : 'kitchen'} items
      </p>
      {rows.length ? (
        <ol className="mt-3 space-y-2">
          {rows.map((r, i) => (
            <li key={r.name} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-gray-700"><span className="mr-2 text-xs text-gray-400">{i + 1}</span>{r.name}</span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="font-semibold text-gray-900">{formatCurrency(r.revenue)}</span>
                <span className="ml-2 text-xs text-gray-400">{r.quantity} sold</span>
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="mt-3 text-sm text-gray-400">No {type === 'bot' ? 'bar' : 'kitchen'} sales in this period.</p>}
    </div>
  );
}
