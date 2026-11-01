/**
 * Browser side of the print helper queue (see lib/print-jobs.js). The server
 * answers a ticket request with `print`: `{ mode: 'browser' }` means print with
 * the dialog as before; `{ mode: 'helper', queued, held, failed }` means the
 * print helper is sending each ticket to its own printer.
 */

import { apiJson } from '@/lib/authed-fetch';

const stationName = (station) => (station === 'bar' ? 'bar' : 'kitchen');

export function helperPrinting(print) {
  return print?.mode === 'helper';
}

/** One success line and any warnings for a helper-mode print result. */
export function helperPrintMessages(print) {
  const queued = print?.queued || [];
  const success = queued.length
    ? `${queued.map((j) => `${j.label} → ${stationName(j.station)} printer`).join(', ')}.`
    : null;
  const warnings = [];
  if (print?.held?.length) warnings.push(`${print.held.join(', ')} saved, but no printer is set for that station (Admin → Printer). Reprint it once one is set.`);
  if (print?.failed?.length) warnings.push(`${print.failed.join(', ')} saved, but could not be sent to the printer. Reprint it from KOT history.`);
  return { success, warnings };
}

/**
 * After a short wait, check the queued tickets actually printed and warn by
 * ticket number if not (helper offline, printer off or out of paper), so a
 * ticket is never lost silently.
 */
export function watchHelperPrints(print, notify, { delayMs = 15000 } = {}) {
  const queued = print?.queued || [];
  if (!queued.length) return;
  setTimeout(async () => {
    try {
      const data = await apiJson(`/api/admin/print-jobs?ids=${queued.map((j) => j.id).join(',')}`);
      const stuck = (data.jobs || []).filter((j) => j.status !== 'done');
      if (!stuck.length) return;
      const detail = stuck.map((j) => `${j.label} (${stationName(j.station)}${j.last_error ? `: ${j.last_error}` : ''})`).join(', ');
      notify(`Not printed yet: ${detail}. Check the printer and that the print helper is running.`, 'warning');
    } catch { /* status check is best-effort */ }
  }, delayMs);
}
