/**
 * KOT / BOT ticket as plain thermal-printer lines for the print helper. Mirrors
 * printKot in lib/pos-print.js (same settings, same fields, never prices) but
 * as text the helper turns into ESC/POS, so it prints without a browser.
 *
 * Each line: { text, align: 'left'|'center', size: 'normal'|'tall'|'big', bold }.
 * 'tall' doubles height only (width stays `cols`); 'big' doubles both, so a
 * big line fits half as many characters.
 */

import { compactOrderNumber } from '@/lib/document-display.js';
import { formatNepalTime } from '@/lib/time-utils.js';
import { resolvePrinterSettings, settingEnabled, qtyAfterItem } from '@/lib/printer-settings.js';
import { productionTypeForTicket } from '@/lib/production-type.js';

export function ticketColumns(size) {
  return String(size) === '58' ? 32 : 48;
}

// Thermal code pages are ASCII-safe; anything else would print as garbage.
function ascii(value) {
  return String(value ?? '')
    .replace(/[×✕]/g, 'x')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

function wrap(text, width) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
    while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

function row(label, value, width) {
  const l = ascii(label);
  const v = ascii(value);
  const gap = Math.max(1, width - l.length - v.length);
  return `${l}${' '.repeat(gap)}${v}`.slice(0, width);
}

/**
 * @param {object} kot       KOT/BOT snapshot from getKot (items included)
 * @param {object} settings  system settings (printer keys)
 * @param {object} opts      { reprint, size }
 */
export function ticketPrintLines(kot, settings = {}, { reprint = false, size } = {}) {
  const p = resolvePrinterSettings(settings);
  const cols = ticketColumns(size || p.receipt_paper_size);
  const isBar = productionTypeForTicket(kot) === 'bot';
  const isCancel = kot.kot_type === 'cancellation';
  const isReprint = reprint || kot.is_reprint || Number(kot.reprint_count || 0) > 0;
  const tag = isCancel ? 'CANCELLATION' : (kot.kot_type === 'additional' ? 'ADDITIONAL' : 'NEW');
  const dest = kot.order_type === 'delivery' ? 'DELIVERY'
    : kot.table_number ? `TABLE ${kot.table_number}` : 'TAKEAWAY';
  const lines = [];
  const add = (text, opts = {}) => lines.push({ text: ascii(text), align: 'left', size: 'normal', bold: false, ...opts });
  const rule = () => add('-'.repeat(cols));

  if (settingEnabled(p.kot_show_restaurant)) add(p.restaurant_name || 'Chulo Cottage', { align: 'center', bold: true });
  add(isBar ? p.bot_title : p.kot_title, { align: 'center', bold: true, size: 'tall' });
  if (isCancel) add('*** CANCELLATION ***', { align: 'center', bold: true });
  if (isReprint) add('*** REPRINT ***', { align: 'center', bold: true });
  rule();
  if (settingEnabled(p.kot_show_destination)) add(dest, { align: 'center', bold: true, size: 'big' });
  add(row(isBar ? p.bot_number_label : p.kot_number_label, kot.kot_number, cols), { bold: true });
  if (settingEnabled(p.kot_show_sequence)) add(row(p.kot_sequence_label, `#${kot.sequence} (${tag})`, cols));
  if (settingEnabled(p.kot_show_order)) add(row(p.kot_order_label, compactOrderNumber(kot.order_number) || kot.order_id, cols));
  if (settingEnabled(p.kot_show_issued_by)) add(row('By', kot.issued_by_name || '-', cols));
  if (settingEnabled(p.kot_show_time)) add(row('Time', formatNepalTime(kot.printed_at || new Date()), cols));
  rule();

  const after = qtyAfterItem(p.kot_qty_position);
  for (const it of kot.items || []) {
    const qty = `${ascii(it.quantity)}x`;
    const nameWidth = cols - qty.length - 1;
    const nameLines = wrap(isCancel ? `CANCEL ${it.item_name}` : it.item_name, nameWidth);
    nameLines.forEach((name, i) => {
      const text = i > 0 ? (after ? name : `${' '.repeat(qty.length + 1)}${name}`)
        : after ? `${name}${' '.repeat(Math.max(1, cols - name.length - qty.length))}${qty}` : `${qty} ${name}`;
      add(text, { bold: true, size: 'tall' });
    });
    if (it.variant_name) wrap(`> ${it.variant_name}`, cols - 2).forEach((t) => add(`  ${t}`));
    if (it.special_instructions) wrap(`>> ${it.special_instructions}`, cols - 2).forEach((t) => add(`  ${t}`));
  }

  if (settingEnabled(p.kot_show_notes) && kot.order_notes) {
    rule();
    wrap(`${p.kot_note_label}: ${kot.order_notes}`, cols).forEach((t) => add(t, { bold: true }));
  }
  rule();
  if (p.kot_footer) add(p.kot_footer, { align: 'center' });
  add(`${isReprint ? `Reprint #${kot.reprint_count || 1} - ` : ''}${formatNepalTime(new Date())}`, { align: 'center' });
  return { cols, lines };
}

/** A short test page so each printer can be checked from Admin → Printer. */
export function testPrintLines(station, settings = {}) {
  const p = resolvePrinterSettings(settings);
  const cols = ticketColumns(p.receipt_paper_size);
  const name = station === 'bar' ? 'BAR PRINTER' : 'KITCHEN PRINTER';
  return {
    cols,
    lines: [
      { text: ascii(p.restaurant_name || 'Chulo Cottage'), align: 'center', size: 'normal', bold: true },
      { text: name, align: 'center', size: 'big', bold: true },
      { text: '-'.repeat(cols), align: 'left', size: 'normal', bold: false },
      { text: `Test print - ${station === 'bar' ? 'BOT' : 'KOT'} tickets print here.`, align: 'left', size: 'normal', bold: false },
      { text: ascii(formatNepalTime(new Date())), align: 'center', size: 'normal', bold: false },
    ],
  };
}
