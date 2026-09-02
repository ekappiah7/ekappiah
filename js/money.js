// Money is stored as an integer number of minor units (pesewas for GHS).
// Nothing in this app ever holds a currency amount in a float — 0.1 + 0.2 is
// not 0.3, and a ledger that drifts by a pesewa a month is a ledger nobody
// trusts.

export const MINOR = 100;

/** "1,234.5" | "1234.50" | "-12" -> integer minor units. NaN-safe: returns null. */
export function parseAmount(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Math.round(input * MINOR);
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }      // (1,234.00)
  s = s.replace(/[^0-9.,\-]/g, '');                                      // strip GHS, ₵, spaces
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  s = s.replace(/-/g, '');
  // Decide which separator is the decimal point: the last one, if it leaves
  // 1-2 trailing digits. Otherwise both are thousands separators.
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  const cut = Math.max(lastDot, lastComma);
  if (cut > -1 && s.length - cut - 1 <= 2 && s.length - cut - 1 > 0) {
    s = s.slice(0, cut).replace(/[.,]/g, '') + '.' + s.slice(cut + 1);
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * MINOR) * (negative ? -1 : 1);
}

const fmtCache = new Map();
function formatter(currency, opts) {
  const key = currency + JSON.stringify(opts);
  if (!fmtCache.has(key)) {
    let f;
    try {
      f = new Intl.NumberFormat('en-GH', { style: 'currency', currency, ...opts });
    } catch {
      f = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', ...opts });
    }
    fmtCache.set(key, f);
  }
  return fmtCache.get(key);
}

/** Integer minor units -> "GH₵1,234.50" */
export function formatMoney(minor, currency = 'GHS', { compact = false, signed = false } = {}) {
  const value = (minor || 0) / MINOR;
  // Compact is for headline tiles. Below a thousand there is nothing to
  // compact, and "GH₵445.1" reads as a broken number rather than a short one.
  const opts = compact
    ? { notation: 'compact', maximumFractionDigits: Math.abs(value) < 1000 ? 0 : 1 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const body = formatter(currency, opts).format(Math.abs(value));
  const sign = minor < 0 ? '−' : (signed && minor > 0 ? '+' : '');
  return sign + body;
}

/** Bare number, for input fields: 123450 -> "1234.50" */
export function toInput(minor) {
  if (minor === null || minor === undefined) return '';
  return (Math.abs(minor) / MINOR).toFixed(2);
}

export function formatPercent(fraction, digits = 0) {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return (fraction * 100).toFixed(digits) + '%';
}
