'use client';

/**
 * Free-text remark saved with a bill payment (e.g. "paid by son", "eSewa from
 * 98XXXXXXXX"). Stored on the payment lines; shown in bill and order details.
 */
export default function PaymentRemarkField({ value, onChange, className = '' }) {
  return (
    <label className={`block text-xs font-semibold text-slate-700 ${className}`}>
      Remark (optional)
      <textarea
        rows={2}
        maxLength={500}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. paid by son, or which eSewa account"
        className="mt-1 w-full resize-none rounded-lg border border-slate-200 px-2 py-2 text-sm font-normal"
      />
    </label>
  );
}
