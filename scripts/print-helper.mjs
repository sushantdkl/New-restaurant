#!/usr/bin/env node
/**
 * Chulo Cottage print helper — sends kitchen tickets (KOT) to the kitchen
 * printer and bar tickets (BOT) to the bar printer, at the same time, without
 * a print dialog.
 *
 * Run it on one PC in the restaurant that can reach both printers (Node 18+,
 * no other installs needed; this one file can be copied on its own):
 *
 *   node print-helper.mjs --url https://your-site.example --key YOUR_HELPER_KEY
 *
 * or set PRINT_HELPER_URL / PRINT_HELPER_KEY, or put {"url": "...", "key": "..."}
 * in print-helper.json next to this file. The key comes from Admin → Printer →
 * Print helper. Printers are chosen in Admin → Printer, per station:
 *   network: the printer's IP, e.g. 192.168.1.50 (port 9100 unless given)
 *   windows: the installed printer's name, e.g. "EPSON TM-T82 Receipt"
 * Both receive ESC/POS (standard for thermal receipt printers).
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const POLL_MS = 1500;
const ERROR_WAIT_MS = 5000;
const NETWORK_TIMEOUT_MS = 8000;

function loadConfig() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let file = {};
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(process.cwd(), 'print-helper.json'), path.join(here, 'print-helper.json')]) {
    if (fs.existsSync(candidate)) { file = JSON.parse(fs.readFileSync(candidate, 'utf8')); break; }
  }
  const url = (arg('url') || process.env.PRINT_HELPER_URL || file.url || '').replace(/\/+$/, '');
  const key = arg('key') || process.env.PRINT_HELPER_KEY || file.key || '';
  if (!url || !key) {
    console.error('Usage: node print-helper.mjs --url https://your-site.example --key YOUR_HELPER_KEY');
    process.exit(1);
  }
  return { url, key };
}

// ---------------------------------------------------------------------------
// ESC/POS

const ESC = 0x1b;
const GS = 0x1d;
const SIZE = { normal: 0x00, tall: 0x01, big: 0x11 };

function wrapText(text, width) {
  const out = [];
  let rest = String(text);
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

export function escposTicket({ cols = 48, lines = [] }) {
  const bytes = [ESC, 0x40]; // initialise
  for (const line of lines) {
    const size = SIZE[line.size] ?? 0x00;
    const width = line.size === 'big' ? Math.floor(cols / 2) : cols;
    bytes.push(ESC, 0x61, line.align === 'center' ? 1 : 0);
    bytes.push(ESC, 0x45, line.bold ? 1 : 0);
    bytes.push(GS, 0x21, size);
    for (const part of wrapText(line.text || '', width)) {
      bytes.push(...Buffer.from(part, 'ascii'), 0x0a);
    }
  }
  bytes.push(ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x61, 0);
  bytes.push(ESC, 0x64, 4); // feed so the cut clears the text
  bytes.push(GS, 0x56, 0x42, 0x00); // partial cut
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Printers

function printNetwork(target, data) {
  const [host, port] = target.split(':');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) || 9100 });
    socket.setTimeout(NETWORK_TIMEOUT_MS);
    socket.on('connect', () => socket.end(data));
    socket.on('timeout', () => { socket.destroy(); reject(new Error(`Printer ${target} did not answer`)); });
    socket.on('error', (error) => reject(new Error(`Printer ${target}: ${error.code || error.message}`)));
    socket.on('close', (hadError) => { if (!hadError) resolve(); });
  });
}

const RAW_PRINT_PS1 = `param([string]$Printer, [string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr handle;
    if (!OpenPrinter(printer, out handle, IntPtr.Zero)) throw new Exception("Printer not found: " + printer);
    try {
      if (StartDocPrinter(handle, 1, new DOCINFO { pDocName = "Ticket", pDataType = "RAW" }) == 0) throw new Exception("Could not start the print job");
      StartPagePrinter(handle);
      int written;
      bool ok = WritePrinter(handle, data, data.Length, out written);
      EndPagePrinter(handle);
      EndDocPrinter(handle);
      if (!ok || written != data.Length) throw new Exception("Could not send the ticket to the printer");
    } finally { ClosePrinter(handle); }
  }
}
"@
[RawPrint]::Send($Printer, [IO.File]::ReadAllBytes($Path))
`;

let scriptPath = null;
function rawPrintScript() {
  if (!scriptPath) {
    scriptPath = path.join(os.tmpdir(), 'chulo-print-helper-raw.ps1');
    fs.writeFileSync(scriptPath, RAW_PRINT_PS1);
  }
  return scriptPath;
}

function printWindows(target, data) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows printers need the helper to run on Windows'));
  const file = path.join(os.tmpdir(), `chulo-ticket-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(file, data);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', rawPrintScript(), '-Printer', target, '-Path', file],
      { timeout: 30000, windowsHide: true },
      (error, _stdout, stderr) => {
        fs.rm(file, { force: true }, () => {});
        if (error) reject(new Error((String(stderr).split('\n').find((l) => l.trim()) || error.message).trim()));
        else resolve();
      });
  });
}

function sendToPrinter(printer, data) {
  return printer.connection === 'windows' ? printWindows(printer.target, data) : printNetwork(printer.target, data);
}

// ---------------------------------------------------------------------------
// Queue loop

async function api(config, url, options = {}) {
  const res = await fetch(`${config.url}${url}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server answered ${res.status}`);
  return data;
}

const stamp = () => new Date().toLocaleTimeString();

async function printStation(config, jobs) {
  // One station's tickets print in order; stations run side by side.
  for (const job of jobs) {
    try {
      await sendToPrinter(job.printer, escposTicket(job.payload));
      console.log(`${stamp()}  printed ${job.label} on ${job.station === 'bar' ? 'bar' : 'kitchen'} printer`);
      await api(config, `/api/print-helper/jobs/${job.id}`, { method: 'POST', body: JSON.stringify({ ok: true }) });
    } catch (error) {
      console.error(`${stamp()}  FAILED ${job.label}: ${error.message}`);
      await api(config, `/api/print-helper/jobs/${job.id}`, { method: 'POST', body: JSON.stringify({ ok: false, error: error.message }) })
        .catch(() => {});
    }
  }
}

async function main() {
  const config = loadConfig();
  console.log(`Print helper connected to ${config.url}. Leave this window open.`);
  let lastError = '';
  for (;;) {
    let wait = POLL_MS;
    try {
      const { jobs = [] } = await api(config, '/api/print-helper/jobs');
      if (lastError) { console.log(`${stamp()}  reconnected`); lastError = ''; }
      const byStation = new Map();
      for (const job of jobs) byStation.set(job.station, [...(byStation.get(job.station) || []), job]);
      await Promise.all([...byStation.values()].map((stationJobs) => printStation(config, stationJobs)));
      if (jobs.length) wait = 0;
    } catch (error) {
      if (error.message !== lastError) console.error(`${stamp()}  ${error.message}`);
      lastError = error.message;
      wait = ERROR_WAIT_MS;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
