'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BanknoteArrowDown, Plus, Trash2, X } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { friendlyMessage, friendlyFromError } from '@/lib/friendly-message';
import { apiJson } from '@/lib/authed-fetch';
import { nepalDateString } from '@/lib/report-dates.js';
import DateInput from '@/components/ui/date-input.jsx';
import { formatCalendarDate, formatCalendarMonth } from '@/lib/calendar-system.js';

const money = (n) => `Rs ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const METHODS = ['cash', 'online', 'business_funding'];
const methodLabel = (method) => ({ cash: 'Business Cash', online: 'Bank / Online', business_funding: 'Business Funding' }[method] || method);
const today = () => nepalDateString();
const currentPeriod = () => formatCalendarMonth();

export default function PayrollDrawer({
  employee,
  onClose,
  initialAction,
  canRecordSalary = true,
  canGiveAdvance = true,
  canDelete = true,
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirm();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [details, setDetails] = useState(null);
  const loadVersion = useRef(0);
  const requestKeys = useRef({});
  const [adjustment, setAdjustment] = useState({ type: 'absence', absent_days: '', amount: '', note: '' });
  const [payments, setPayments] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [outstanding, setOutstanding] = useState(Number(employee.advance_outstanding || 0));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const allowedInitialAction = initialAction === 'advance' && canGiveAdvance
    ? 'advance'
    : canRecordSalary ? 'salary' : 'advance';
  const [action, setAction] = useState(allowedInitialAction);
  const [payment, setPayment] = useState({
    gross_amount: employee.salary ?? '',
    advance_deduction: '',
    period_label: currentPeriod(),
    salary_month: today().slice(0, 7),
    paid_on: today(),
    method: 'cash',
    note: '',
  });
  const [advance, setAdvance] = useState({ amount: '', advanced_on: today(), method: 'cash', note: '' });

  const load = async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const data = await apiJson(`/api/admin/payroll?employee_id=${employee.id}&month=${month}`);
      if (version !== loadVersion.current) return;
      setDetails(data);
      const remaining = Number(data.statement?.remaining || 0);
      const settlement = Math.max(0, Math.min(Number(data.outstanding || 0), Number(data.statement?.available_for_advance_settlement || 0)));
      setPayment((v) => ({ ...v, gross_amount: remaining + settlement, advance_deduction: settlement, salary_month: month, period_label: month }));
      setPayments(data.payments || []);
      setAdvances(data.advances || []);
      setOutstanding(Number(data.outstanding || 0));
    } catch (error) {
      addToast(friendlyFromError(error, 'load_failed'));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  };

  useEffect(() => {
    setAction(allowedInitialAction);
    setPayment((current) => ({ ...current, gross_amount: employee.salary ?? '', advance_deduction: '' }));
    load();
    return () => { loadVersion.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id, initialAction, month]);

  const deduction = Math.max(0, Number(payment.advance_deduction || 0));
  const gross = Math.max(0, Number(payment.gross_amount || 0));
  const netPay = Math.max(0, gross - deduction);
  const totalPaid = useMemo(
    () => payments.reduce((sum, row) => sum + Number(row.gross_amount ?? row.amount ?? 0), 0),
    [payments]
  );

  const savePayroll = async (type, body) => {
    const requestKey = requestKeys.current[type] ||= crypto.randomUUID();
    const send = (useFunding = false) => apiJson('/api/admin/payroll', {
      method: 'POST', body: JSON.stringify({ ...body, request_key: requestKey, use_business_funding: useFunding }),
    });
    let result;
    try { result = await send(); }
    catch (error) {
      if (error.code !== 'business_funding_required') throw error;
      const approved = await confirm({ title: 'Use Business Funding?',
        message: `The selected balance is short by ${money(error.shortfall)}. Business Funding has ${money(error.available)} available. Use it for the shortfall?`,
        confirmLabel: 'Use Business Funding', tone: 'warning' });
      if (!approved) return false;
      result = await send(true);
    }
    delete requestKeys.current[type];
    return result;
  };

  const recordSalary = async (event) => {
    event.preventDefault();
    if (!(gross > 0)) return addToast(friendlyMessage('validation', { description: 'Enter the gross salary.' }));
    if (deduction > outstanding || deduction > gross) {
      return addToast(friendlyMessage('validation', { description: 'Advance deduction cannot exceed the salary or outstanding advance.' }));
    }
    setSaving(true);
    try {
      const saved = await savePayroll('payment', {
          ...payment,
          employee_id: employee.id,
          gross_amount: gross,
          advance_deduction: deduction,
          amount: netPay,
      });
      if (!saved) return;
      addToast(friendlyMessage('save_success', { description: 'Salary payment recorded.' }));
      setPayment((current) => ({ ...current, note: '', advance_deduction: '' }));
      await load();
    } catch (error) {
      addToast(friendlyFromError(error, 'save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const recordAdvance = async (event) => {
    event.preventDefault();
    if (!(Number(advance.amount) > 0)) return addToast(friendlyMessage('validation', { description: 'Enter the advance amount.' }));
    setSaving(true);
    try {
      const saved = await savePayroll('advance', { ...advance, type: 'advance', employee_id: employee.id, amount: Number(advance.amount) });
      if (!saved) return;
      addToast(friendlyMessage('save_success', { description: 'Salary advance recorded.' }));
      setAdvance((current) => ({ ...current, amount: '', note: '' }));
      await load();
    } catch (error) {
      addToast(friendlyFromError(error, 'save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const recordAdjustment = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await savePayroll(adjustment.type, { ...adjustment, employee_id: employee.id, salary_month: month });
      if (!saved) return;
      setAdjustment((v) => ({ ...v, absent_days: '', amount: '', note: '' }));
      addToast(friendlyMessage('save_success', { description: 'Salary adjustment recorded.' }));
      await load();
    } catch (error) { addToast(friendlyFromError(error, 'save_failed')); }
    finally { setSaving(false); }
  };

  const remove = async (id, type) => {
    const ok = await confirm({
      title: `Delete this ${type}?`,
      message: `This removes the ${type} and reverses its accounting entry.`,
      confirmLabel: 'Delete',
      tone: 'delete',
    });
    if (!ok) return;
    try {
      await apiJson(`/api/admin/payroll?id=${id}${type === 'advance' ? '&type=advance' : ''}`, { method: 'DELETE' });
      load();
    } catch (error) {
      addToast(friendlyFromError(error, 'delete_failed'));
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={`Salary and advances for ${employee.full_name || employee.username}`} className="relative z-10 flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Salary &amp; advances</p>
            <h2 className="text-lg font-semibold text-gray-900">{employee.full_name || employee.username}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100" aria-label="Close"><X className="h-5 w-5" /></button>
        </header>

        <div className="space-y-5 p-5">
          <Field label="Salary month (AD)"><input type="month" value={month} disabled={saving} onChange={(e) => { if (e.target.value) { setLoading(true); setMonth(e.target.value); } }} className={INPUT} /></Field>
          {details?.statement && <section className="rounded-xl border border-gray-200 p-4 text-sm text-gray-900">
            <p className="mb-3 font-semibold">Monthly salary calculation</p>
            <p className="mb-3 text-xs text-gray-500">Tracking starts {details.statement.tracking_start}. Positive opening balances are unpaid salary; negative balances are deductions carried forward.</p>
            {[
              ['Opening balance', details.statement.opening], ['Monthly salary', details.statement.salary],
              ['Advances given this month', -details.statement.advanced], ['Absence deductions', -details.statement.absences],
              ['Salary paid for this month', -details.statement.paid], ['Deductions waived', details.statement.waived],
            ].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-1"><span>{label}</span><span>{money(value)}</span></div>)}
            <div className="mt-3 flex justify-between border-t pt-3 font-bold"><span>{details.statement.balance < 0 ? 'Deduction carried to next month' : 'Remaining salary to pay'}</span><span>{money(Math.abs(details.statement.balance))}</span></div>
          </section>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Monthly salary" value={details?.statement ? money(details.statement.salary) : '—'} />
            <Stat label="Advance due" value={money(outstanding)} tone={outstanding > 0 ? 'amber' : 'default'} />
            <Stat label="Salary recorded" value={money(totalPaid)} />
            <Stat label="Advance records" value={String(advances.length)} />
          </div>

          {(canRecordSalary || canGiveAdvance) && (
            <div className="rounded-xl border border-gray-200 p-4">
              <p className="mb-3 text-xs text-gray-600">Business Funding available: <strong>{money(details?.funding_available)}</strong>. Choose it directly, or use it to cover a Cash / Online shortfall when prompted.</p>
              {canRecordSalary && canGiveAdvance && (
                <div className="mb-4 grid grid-cols-2 rounded-lg bg-gray-100 p-1">
                  <ActionTab active={action === 'salary'} onClick={() => setAction('salary')}>Pay salary</ActionTab>
                  <ActionTab active={action === 'advance'} onClick={() => setAction('advance')}>Give advance</ActionTab>
                </div>
              )}

              {action === 'salary' && canRecordSalary ? (
                <form onSubmit={recordSalary}>
                  <p className="mb-3 text-sm font-semibold text-gray-900">Record salary payment</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Salary settled (Rs)"><input type="number" min="0" step="any" value={payment.gross_amount} onChange={(e) => setPayment({ ...payment, gross_amount: e.target.value })} className={INPUT} /></Field>
                    <Field label={`Advance deduction (due ${money(outstanding)})`}><input type="number" min="0" max={Math.min(gross, outstanding)} step="any" value={payment.advance_deduction} onChange={(e) => setPayment({ ...payment, advance_deduction: e.target.value })} className={INPUT} placeholder="0" /></Field>
                    <Field label="Paid on"><DateInput value={payment.paid_on} onChange={(v) => setPayment({ ...payment, paid_on: v })} className={INPUT} /></Field>
                    <Field label="Salary month (AD)"><input type="month" required value={payment.salary_month} readOnly className={INPUT} /><span className="text-xs text-gray-500">Select the month above to update the calculation.</span></Field>
                    <Field label="Method"><select value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })} className={INPUT}>{METHODS.map((method) => <option key={method} value={method}>{methodLabel(method)}</option>)}</select></Field>
                    <Field label="Paid now"><div className="flex h-10 items-center rounded-lg bg-emerald-50 px-3 text-sm font-semibold text-emerald-800">{money(netPay)}</div></Field>
                  </div>
                  <Field label="Note"><input value={payment.note} onChange={(e) => setPayment({ ...payment, note: e.target.value })} className={INPUT} placeholder="Optional" /></Field>
                  <button type="submit" disabled={saving || loading} className={PRIMARY}><Plus className="h-4 w-4" /> {saving ? 'Saving…' : 'Record salary'}</button>
                </form>
              ) : canGiveAdvance ? (
                <form onSubmit={recordAdvance}>
                  <p className="mb-1 text-sm font-semibold text-gray-900">Give salary advance</p>
                  <p className="mb-3 text-xs text-gray-500">This is deducted from a future salary payment and remains visible until settled.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Amount (Rs)"><input type="number" min="0" step="any" value={advance.amount} onChange={(e) => setAdvance({ ...advance, amount: e.target.value })} className={INPUT} /></Field>
                    <Field label="Date"><DateInput value={advance.advanced_on} onChange={(v) => setAdvance({ ...advance, advanced_on: v })} className={INPUT} /></Field>
                    <Field label="Method"><select value={advance.method} onChange={(e) => setAdvance({ ...advance, method: e.target.value })} className={INPUT}>{METHODS.map((method) => <option key={method} value={method}>{methodLabel(method)}</option>)}</select></Field>
                    <Field label="Note"><input value={advance.note} onChange={(e) => setAdvance({ ...advance, note: e.target.value })} className={INPUT} placeholder="Optional reason" /></Field>
                  </div>
                  <button type="submit" disabled={saving || loading} className={PRIMARY}><BanknoteArrowDown className="h-4 w-4" /> {saving ? 'Saving…' : 'Give advance'}</button>
                </form>
              ) : null}
            </div>
          )}

          {details?.can_adjust && <form onSubmit={recordAdjustment} className="space-y-3 rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-900">Absence deduction / admin waiver</p>
            <Field label="Adjustment"><select className={INPUT} value={adjustment.type} onChange={(e) => setAdjustment({ ...adjustment, type: e.target.value })}>
              <option value="absence">Record absent days</option><option value="advance_waiver">Waive advance deduction</option><option value="absence_waiver">Waive absence deduction</option>
            </select></Field>
            {adjustment.type === 'absence' ? <>
              {!details.absence_enabled && <p className="text-xs text-amber-700">Absence deductions are off. Enable them in Settings / Business.</p>}
              <Field label="Absent days"><input type="number" min="0.5" max="31" step="0.5" required className={INPUT} value={adjustment.absent_days} onChange={(e) => setAdjustment({ ...adjustment, absent_days: e.target.value })} /></Field>
              <p className="text-sm text-gray-700">{Number(adjustment.absent_days || 0)} days x {money(details.absence_daily_rate)} = {money(Number(adjustment.absent_days || 0) * details.absence_daily_rate)}</p>
            </> : <Field label="Amount to waive (Rs)"><input type="number" min="0.01" step="0.01" required className={INPUT} value={adjustment.amount} onChange={(e) => setAdjustment({ ...adjustment, amount: e.target.value })} /></Field>}
            <Field label="Reason (required)"><input required minLength={3} className={INPUT} value={adjustment.note} onChange={(e) => setAdjustment({ ...adjustment, note: e.target.value })} /></Field>
            <button className={PRIMARY} disabled={saving || loading || (adjustment.type === 'absence' && !details.absence_enabled)}>Save adjustment</button>
          </form>}
          <History title="Salary rate history" empty="No monthly salary configured." loading={loading}>
            {(details?.terms || []).map((row) => <div key={row.id} className="flex justify-between gap-3 px-4 py-3 text-sm text-gray-900"><span>From {row.effective_month} (AD)</span><span className="font-semibold">{money(row.salary)} / month</span></div>)}
          </History>
          <History title="Deduction and waiver history" empty="No deductions or waivers recorded." loading={loading}>
            {(details?.adjustments || []).map((row) => <div key={row.id} className="px-4 py-3 text-sm text-gray-900">
              <p className="font-semibold">{row.salary_month} | {row.kind.replaceAll('_', ' ')} | {money(row.amount)}</p>
              {row.kind === 'absence' && <p>{row.absent_days} days x {money(row.daily_rate)} = {money(row.amount)}</p>}
              <p className="text-xs text-gray-500">{row.note} | {row.created_by_name || 'Admin'} | {String(row.created_at).slice(0, 19)}</p>
            </div>)}
          </History>
          <History title="Advance history" empty="No advances recorded." loading={loading}>
            {advances.map((row) => (
              <HistoryRow key={`a-${row.id}`} amount={row.amount} date={row.advanced_on} method={row.method} note={row.note} label="Advance" tone="amber">
                {Number(row.funding_amount) > 0 && <span className="text-xs text-emerald-700">{money(row.funding_amount)} from Business Funding</span>}
                {canDelete && <DeleteButton onClick={() => remove(row.id, 'advance')} />}
              </HistoryRow>
            ))}
          </History>

          <History title="Salary payment history" empty="No salary payments recorded." loading={loading}>
            {payments.map((row) => (
              <HistoryRow key={`p-${row.id}`} amount={row.amount} date={row.paid_on} method={row.method} note={row.note} label={row.salary_month || row.period_label || 'Salary'}>
                <div className="flex items-center gap-2">
                  {Number(row.funding_amount) > 0 && <span className="text-xs text-emerald-700">{money(row.funding_amount)} from Business Funding</span>}
                  {Number(row.advance_deduction || 0) > 0 && <span className="text-xs text-amber-700">{money(row.advance_deduction)} deducted</span>}
                  {canDelete && <DeleteButton onClick={() => remove(row.id, 'payment')} />}
                </div>
              </HistoryRow>
            ))}
          </History>
        </div>
      </aside>
    </div>, document.body
  );
}

const INPUT = 'mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-900';
const PRIMARY = 'mt-3 inline-flex h-10 items-center gap-1.5 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800 active:scale-[0.98] disabled:opacity-50';

function Field({ label, children }) { return <label className="block [&>div]:w-full"><span className="block text-sm font-medium text-gray-700">{label}</span>{children}</label>; }
function ActionTab({ active, onClick, children }) { return <button type="button" onClick={onClick} className={`rounded-md px-3 py-2 text-sm font-medium ${active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{children}</button>; }
function Stat({ label, value, tone = 'default' }) { return <div className={`rounded-xl border p-3 ${tone === 'amber' ? 'border-amber-200 bg-amber-50' : 'border-gray-200'}`}><p className="text-xs font-medium text-gray-500">{label}</p><p className="mt-1 truncate text-base font-bold text-gray-900">{value}</p></div>; }
function History({ title, empty, loading, children }) { const rows = Array.isArray(children) ? children : [children]; return <section><p className="mb-2 text-sm font-semibold text-gray-900">{title}</p>{loading ? <p className="text-sm text-gray-500">Loading…</p> : rows.filter(Boolean).length === 0 ? <p className="rounded-lg bg-gray-50 px-3 py-4 text-center text-sm text-gray-500">{empty}</p> : <div className="divide-y divide-gray-100 rounded-xl border border-gray-200">{children}</div>}</section>; }
function HistoryRow({ amount, date, method, note, label, tone, children }) { return <div className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-semibold text-gray-900">{money(amount)}</p><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone === 'amber' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}>{label}</span></div><p className="text-xs capitalize text-gray-500">{formatCalendarDate(String(date).slice(0, 10))} · {methodLabel(method)}</p>{note && <p className="truncate text-xs text-gray-400">{note}</p>}</div>{children}</div>; }
function DeleteButton({ onClick }) { return <button type="button" onClick={onClick} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>; }
