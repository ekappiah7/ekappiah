// Getting history in without typing it. Two doors: a pasted wall of MoMo SMS,
// and a bank CSV. Both produce draft transactions that you review before they
// are committed — an importer that writes straight to the ledger is an
// importer you stop trusting the first time it guesses wrong.

import { parseAmount } from './money.js';
import { today } from './store.js';

// ------------------------------------------------------------------- CSV

/** RFC4180-ish: quoted fields, doubled quotes, embedded newlines, CR/LF. */
export function parseCSV(text, delimiter = ',') {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

export function sniffDelimiter(text) {
  const line = text.split(/\r?\n/).find(l => l.trim()) || '';
  const best = [',', ';', '\t', '|']
    .map(d => ({ d, n: line.split(d).length }))
    .sort((a, b) => b.n - a.n)[0];
  return best.n > 1 ? best.d : ',';
}

const HEADER_HINTS = {
  date:        [/^date$/i, /date/i, /posted/i, /value.?date/i, /trans.*date/i],
  amount:      [/^amount$/i, /^value$/i, /amount/i],
  debit:       [/debit/i, /withdraw/i, /^out$/i, /money out/i, /paid out/i],
  credit:      [/credit/i, /deposit/i, /^in$/i, /money in/i, /paid in/i],
  description: [/description/i, /narration/i, /details/i, /particular/i, /memo/i, /remark/i],
  payee:       [/payee/i, /merchant/i, /beneficiary/i, /counterparty/i, /^to$/i],
  reference:   [/reference/i, /^ref/i, /transaction.?id/i, /trans.*id/i, /cheque/i],
  balance:     [/balance/i],
};

/** Best-guess column mapping — the UI shows it and lets you override. */
export function guessMapping(headers) {
  const mapping = {};
  for (const [field, patterns] of Object.entries(HEADER_HINTS)) {
    for (const pattern of patterns) {
      const idx = headers.findIndex(h => pattern.test((h || '').trim()));
      if (idx > -1 && !Object.values(mapping).includes(idx)) { mapping[field] = idx; break; }
    }
  }
  return mapping;
}

/** Accepts D/M/Y, M/D/Y (only when unambiguous), Y-M-D, "12 Jan 2026". */
export function parseDate(raw, dayFirst = true) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const [, a, b, y] = m;
    let day = dayFirst ? Number(a) : Number(b);
    let month = dayFirst ? Number(b) : Number(a);
    if (month > 12 && day <= 12) { const t = day; day = month; month = t; }
    const year = y.length === 2 ? Number(y) + 2000 : Number(y);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = s.match(/(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})/);
  if (m) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mi = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi > -1) {
      const year = m[3].length === 2 ? Number(m[3]) + 2000 : Number(m[3]);
      return `${year}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/** Turn mapped CSV rows into draft transactions. */
export function rowsToDrafts(rows, mapping, { hasHeader = true, dayFirst = true, accountId = null } = {}) {
  const body = hasHeader ? rows.slice(1) : rows;
  const at = (row, field) => (mapping[field] === undefined ? '' : (row[mapping[field]] || '').trim());
  const drafts = [];
  for (const row of body) {
    let amount = null, kind = null;
    if (mapping.debit !== undefined || mapping.credit !== undefined) {
      const debit = parseAmount(at(row, 'debit'));
      const credit = parseAmount(at(row, 'credit'));
      if (debit) { amount = Math.abs(debit); kind = 'expense'; }
      else if (credit) { amount = Math.abs(credit); kind = 'income'; }
    } else {
      const value = parseAmount(at(row, 'amount'));
      if (value !== null && value !== 0) { amount = Math.abs(value); kind = value < 0 ? 'expense' : 'income'; }
    }
    if (!amount) continue;
    const description = at(row, 'description');
    drafts.push({
      kind, amount, fee: 0,
      occurred_on: parseDate(at(row, 'date'), dayFirst) || today(),
      account_id: accountId,
      payee: at(row, 'payee') || description.slice(0, 60) || null,
      note: description || null,
      external_ref: at(row, 'reference') || null,
      source: 'csv',
      _raw: row.join(' | '),
    });
  }
  return drafts;
}

// -------------------------------------------------------------- MoMo SMS

const AMOUNT = String.raw`(?:GH₵|GHS|GH¢|Ghc|GH\s?cedis?|₵)\s*([\d,]+(?:\.\d{1,2})?)`;
const AMOUNT_RE = new RegExp(AMOUNT, 'i');

const OUTBOUND = [
  /cash\s*out/i, /you have (?:sent|transferred|paid)/i, /payment (?:made|of|to)/i,
  /\bdebited\b/i, /withdraw/i, /purchase/i, /airtime/i, /bundle/i, /\bbill\b/i, /\bsent to\b/i,
];
const INBOUND = [
  /you have received/i, /payment received/i, /cash\s*in/i, /\bcredited\b/i,
  /has been credited/i, /\breceived from\b/i, /deposit/i, /reversal/i, /refund/i,
];

// Tried in order: a real transaction id beats a free-text "Reference:" field,
// which on MTN statements is often just a memo the sender typed.
const REF_PATTERNS = [
  /(?:financial\s+)?transaction\s*(?:id|no\.?|number)\s*[:.#-]?\s*([A-Za-z0-9._-]{4,})/i,
  /\btrans\.?\s*(?:id|no\.?)\s*[:.#-]?\s*([A-Za-z0-9._-]{4,})/i,
  /\btxn\s*(?:id|no\.?)?\s*[:.#-]?\s*([A-Za-z0-9._-]{4,})/i,
  /\bref(?:erence)?\s*(?:id|no\.?|number)?\s*[:.#-]?\s*([A-Za-z0-9._-]{4,})/i,
];

function extractRef(message) {
  for (const pattern of REF_PATTERNS) {
    const m = message.match(pattern);
    if (m) return m[1];
  }
  return null;
}
const FEE_RE = new RegExp(String.raw`fee[^\d]{0,25}` + AMOUNT, 'i');
const DATE_RE = /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})|(\d{4}-\d{2}-\d{2})/;

function splitMessages(blob) {
  const byBlank = blob.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  const lines = blob.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // One message per line is the usual shape of a copied SMS thread, but a
  // single wrapped message would be shredded by that. Re-join lines that carry
  // no amount of their own onto the message above them.
  const messages = [];
  for (const line of lines) {
    if (messages.length && !AMOUNT_RE.test(line) && line.length < 90) {
      messages[messages.length - 1] += ' ' + line;
    } else messages.push(line);
  }
  return messages;
}

function extractPayee(text) {
  const from = text.match(/\bfrom\s+([A-Z0-9][A-Za-z0-9 .'&+-]{2,40}?)(?=\s*(?:[.,;]|\b(?:current|available|new|your|on|at|balance|ref|trans)\b|$))/i);
  const to   = text.match(/\bto\s+([A-Z0-9][A-Za-z0-9 .'&+-]{2,40}?)(?=\s*(?:[.,;]|\b(?:current|available|new|your|on|at|balance|ref|trans)\b|$))/i);
  const name = (from || to || [])[1];
  return name ? name.replace(/\s+/g, ' ').trim() : null;
}

/**
 * Parse a pasted block of mobile-money SMS into draft transactions.
 * Anything it cannot read is returned in `skipped` rather than dropped, so a
 * format it has never seen is visible instead of silently missing.
 */
export function parseMomoSms(blob, { accountId = null, defaultDate = today() } = {}) {
  const drafts = [], skipped = [];
  for (const message of splitMessages(blob || '')) {
    const amountMatch = message.match(AMOUNT_RE);
    if (!amountMatch) { skipped.push({ message, reason: 'no amount found' }); continue; }

    // The fee is an amount too — take it out before reading the main amount so
    // "GHS 100.00 ... Fee: GHS 1.00" does not import as a GHS 1.00 payment.
    const feeMatch = message.match(FEE_RE);
    const fee = feeMatch ? parseAmount(feeMatch[1]) : 0;
    let amount = parseAmount(amountMatch[1]);
    if (feeMatch && amountMatch.index === feeMatch.index) {
      const rest = message.slice(0, feeMatch.index) + message.slice(feeMatch.index + feeMatch[0].length);
      const other = rest.match(AMOUNT_RE);
      amount = other ? parseAmount(other[1]) : amount;
    }
    if (!amount) { skipped.push({ message, reason: 'amount unreadable' }); continue; }

    const outbound = OUTBOUND.some(r => r.test(message));
    const inbound  = INBOUND.some(r => r.test(message));
    if (outbound === inbound) { skipped.push({ message, reason: 'direction unclear' }); continue; }

    const dateMatch = message.match(DATE_RE);
    const ref = extractRef(message);
    drafts.push({
      kind: outbound ? 'expense' : 'income',
      amount,
      fee: fee && fee !== amount ? fee : 0,
      occurred_on: (dateMatch && parseDate(dateMatch[0])) || defaultDate,
      account_id: accountId,
      payee: extractPayee(message),
      note: message.length > 240 ? message.slice(0, 237) + '…' : message,
      external_ref: ref,
      source: 'momo-sms',
      _raw: message,
    });
  }
  return { drafts, skipped };
}

/** Drop drafts already in the ledger (same reference, or same day+amount+kind). */
export function dedupe(drafts, existing) {
  const refs = new Set(existing.filter(t => t.external_ref).map(t => t.external_ref));
  const shapes = new Set(existing.map(t => `${t.occurred_on}|${t.kind}|${t.amount}`));
  const kept = [], duplicates = [];
  const seen = new Set();
  for (const d of drafts) {
    const shape = `${d.occurred_on}|${d.kind}|${d.amount}`;
    const key = d.external_ref || shape;
    if ((d.external_ref && refs.has(d.external_ref)) || shapes.has(shape) || seen.has(key)) {
      duplicates.push(d);
    } else {
      seen.add(key);
      kept.push(d);
    }
  }
  return { kept, duplicates };
}
