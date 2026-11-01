'use client';

/**
 * ALL | KOT | BOT switch. A view filter only: it narrows what is shown and
 * never changes an item's stored type, the order, prices or the bill.
 */
const OPTIONS = [
  { value: 'all', label: 'ALL', title: 'Kitchen and bar' },
  { value: 'kot', label: 'KOT', title: 'Kitchen items' },
  { value: 'bot', label: 'BOT', title: 'Bar items' },
];

export default function ProductionFilter({ value = 'all', onChange, counts = null, className = '' }) {
  return (
    <div role="radiogroup" aria-label="Show kitchen or bar items" className={`inline-flex shrink-0 rounded-xl border border-slate-200 bg-white p-0.5 ${className}`}>
      {OPTIONS.map((option) => {
        const active = value === option.value;
        const count = counts?.[option.value];
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-bold tracking-wide transition-colors ${
              active ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            {option.label}
            {count != null && <span className={`ml-1 font-semibold ${active ? 'text-white/70' : 'text-stone-400'}`}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Small station chip for an order line or ticket. */
export function ProductionBadge({ type }) {
  const bar = type === 'bot';
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ${bar ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-800'}`}>
      {bar ? 'BOT' : 'KOT'}
    </span>
  );
}
