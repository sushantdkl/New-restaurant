'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, RotateCcw, Send } from 'lucide-react';
import { apiJson } from '@/lib/authed-fetch';

const INPUT = 'h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-gray-500 focus:outline-none';
const ONLINE_WITHIN_MS = 30000;

const STATUS_STYLE = {
  done: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  printing: 'bg-sky-50 text-sky-700',
  failed: 'bg-rose-50 text-rose-700',
};

/**
 * Admin → Printer: where kitchen (KOT) and bar (BOT) tickets print. Values live
 * in the page's settings and are saved with the page's Save button; the test,
 * key and job actions act immediately.
 */
export default function TicketRouting({ settings, set, isAdmin }) {
  const helper = settings.print_mode === 'helper';
  const [status, setStatus] = useState({ jobs: [], helper: {} });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState({ tone: '', text: '' });

  const load = useCallback(async () => {
    try { setStatus(await apiJson('/api/admin/print-jobs')); } catch { /* status is informational */ }
  }, []);

  useEffect(() => {
    if (!helper) return undefined;
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [helper, load]);

  const act = async (name, fn) => {
    setBusy(name); setNote({ tone: '', text: '' });
    try { await fn(); await load(); } catch (error) { setNote({ tone: 'error', text: error.error || error.message || 'Something went wrong.' }); }
    finally { setBusy(''); }
  };

  const test = (station) => act(`test-${station}`, async () => {
    await apiJson('/api/admin/print-jobs/test', { method: 'POST', body: JSON.stringify({ station }) });
    setNote({ tone: 'success', text: `Test page sent to the ${station === 'bar' ? 'bar' : 'kitchen'} printer.` });
  });

  const newKey = () => act('key', async () => {
    if (status.helper?.has_key && !window.confirm('Replace the helper key? The helper running now will stop until it gets the new key.')) return;
    const data = await apiJson('/api/admin/print-jobs/helper-key', { method: 'POST' });
    setKey(data.key);
  });

  const lastSeen = Number(status.helper?.last_seen_ms || 0);
  const online = lastSeen && Date.now() - lastSeen < ONLINE_WITHIN_MS;

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 p-4">
      <div>
        <h3 className="font-semibold text-gray-900">Where tickets print</h3>
        <p className="text-sm text-gray-500">
          With the print helper, “Confirm order &amp; Print” sends the KOT to the kitchen printer and the BOT to the bar printer at the same time, with no print dialog.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ['browser', 'This device’s print dialog', 'One printer, chosen in the dialog each time.'],
          ['helper', 'Print helper (kitchen + bar printers)', 'Each ticket goes straight to its own printer.'],
        ].map(([value, label, hint]) => (
          <label key={value} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${settings.print_mode === value ? 'border-gray-900 bg-gray-50' : 'border-gray-200'}`}>
            <input type="radio" name="print_mode" className="mt-0.5" checked={(settings.print_mode || 'browser') === value} onChange={() => set({ print_mode: value })} />
            <span><span className="block font-medium text-gray-900">{label}</span><span className="text-gray-500">{hint}</span></span>
          </label>
        ))}
      </div>

      {helper && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {[['kitchen', 'main', 'Kitchen printer (KOT)'], ['bar', 'bar', 'Bar printer (BOT)']].map(([prefix, station, title]) => {
              const connection = settings[`${prefix}_printer_connection`] || 'network';
              return (
                <fieldset key={prefix} className="space-y-2 rounded-lg border border-gray-200 p-3">
                  <legend className="px-1 text-sm font-semibold text-gray-900">{title}</legend>
                  <label className="block text-sm font-medium text-gray-700">Connected by
                    <select className={`${INPUT} mt-1`} value={connection} onChange={(e) => set({ [`${prefix}_printer_connection`]: e.target.value })}>
                      <option value="network">Network (LAN / Wi-Fi IP address)</option>
                      <option value="windows">Windows printer on the helper PC (USB)</option>
                    </select>
                  </label>
                  <label className="block text-sm font-medium text-gray-700">{connection === 'windows' ? 'Printer name (as in Windows)' : 'IP address'}
                    <input
                      className={`${INPUT} mt-1`}
                      value={settings[`${prefix}_printer_target`] || ''}
                      placeholder={connection === 'windows' ? 'e.g. EPSON TM-T82 Receipt' : 'e.g. 192.168.1.50'}
                      onChange={(e) => set({ [`${prefix}_printer_target`]: e.target.value })}
                    />
                  </label>
                  <button type="button" onClick={() => test(station)} disabled={!!busy || !settings[`${prefix}_printer_target`]} className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-800 disabled:opacity-50">
                    {busy === `test-${station}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Test print
                  </button>
                  <p className="text-xs text-gray-500">Save the page first, then test. Left empty, {prefix} tickets are saved but not printed — never sent to the other printer.</p>
                </fieldset>
              );
            })}
          </div>

          <div className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-gray-900">Print helper
                <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${online ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                  {online ? 'Running' : lastSeen ? `Last seen ${new Date(lastSeen).toLocaleString()}` : 'Not connected yet'}
                </span>
              </p>
              {isAdmin && (
                <button type="button" onClick={newKey} disabled={!!busy} className="inline-flex h-9 items-center gap-2 rounded-lg bg-gray-900 px-3 text-sm font-semibold text-white disabled:opacity-50">
                  <KeyRound className="h-4 w-4" /> {status.helper?.has_key ? 'New helper key' : 'Create helper key'}
                </button>
              )}
            </div>
            <p className="text-gray-500">
              Run it on one PC in the restaurant that can reach both printers (needs Node.js):
            </p>
            <code className="block overflow-x-auto whitespace-pre rounded bg-gray-900 px-3 py-2 text-xs text-gray-100">
              node print-helper.mjs --url {typeof window !== 'undefined' ? window.location.origin : 'https://your-site'} --key {key || 'YOUR_HELPER_KEY'}
            </code>
            {key && <p className="rounded bg-amber-50 px-3 py-2 text-amber-900">Copy this key now — it is shown only once: <b className="break-all font-mono">{key}</b></p>}
            <p className="text-xs text-gray-500">The helper file is <span className="font-mono">scripts/print-helper.mjs</span> in the app; copy that one file to the PC.</p>
          </div>

          {note.text && <p className={`rounded-lg px-3 py-2 text-sm ${note.tone === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>{note.text}</p>}

          {status.jobs?.length > 0 && (
            <div className="overflow-x-auto">
              <p className="mb-2 text-sm font-semibold text-gray-900">Recent prints</p>
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-gray-500"><tr><th className="py-1 pr-3">Ticket</th><th className="py-1 pr-3">Printer</th><th className="py-1 pr-3">Status</th><th className="py-1" /></tr></thead>
                <tbody>
                  {status.jobs.map((job) => (
                    <tr key={job.id} className="border-t border-gray-100">
                      <td className="py-1.5 pr-3 font-medium text-gray-900">{job.label}{job.kind === 'reprint' ? ' (reprint)' : ''}</td>
                      <td className="py-1.5 pr-3 text-gray-600">{job.station === 'bar' ? 'Bar' : 'Kitchen'}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status] || ''}`}>{job.status}</span>
                        {job.last_error && job.status !== 'done' && <span className="ml-2 text-xs text-rose-700">{job.last_error}</span>}
                      </td>
                      <td className="py-1.5 text-right">
                        {job.status === 'failed' && (
                          <button type="button" onClick={() => act(`retry-${job.id}`, () => apiJson(`/api/admin/print-jobs/${job.id}/retry`, { method: 'POST' }))} className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 underline">
                            <RotateCcw className="h-3 w-3" /> Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
