// The domain layer: what a transaction is, what the defaults are, and every
// number the app reports. Nothing here touches the network or the DOM.

import * as db from './db.js';

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

export const today = () => new Date().toISOString().slice(0, 10);
export const monthOf = (isoDate) => isoDate.slice(0, 7);            // 'YYYY-MM'
export const monthStart = (ym) => ym + '-01';
export const thisMonth = () => today().slice(0, 7);

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function monthLabel(ym, { short = false } = {}) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString('en-GB',
    short ? { month: 'short' } : { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Inclusive date bounds for a month key. */
export const monthRange = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from: ym + '-01', to: end };
};

// ------------------------------------------------------------------ defaults
// Seeded on first run. Tuned for a Ghanaian household — MoMo is a first-class
// account, and the categories that actually move money here (tithe, funerals,
// family support, school fees, ECG) get their own lines instead of hiding in
// "Other".

export const DEFAULT_ACCOUNTS = [
  { name: 'Cash',         type: 'cash'    },
  { name: 'MTN MoMo',     type: 'momo'    },
  { name: 'Bank Account', type: 'bank'    },
  { name: 'Savings',      type: 'savings' },
];

// [name, essential, [children...]]
export const DEFAULT_OUT_CATEGORIES = [
  ['Food & Groceries',    true,  ['Groceries', 'Provisions', 'Eating out']],
  ['Housing & Utilities', true,  ['Rent', 'Electricity (ECG)', 'Water', 'Internet & Data', 'Gas / LPG']],
  ['Transport',           true,  ['Fuel', 'Trotro / Taxi / Uber', 'Vehicle maintenance']],
  ['Health',              true,  ['Medicine', 'Clinic & Hospital', 'NHIS / Insurance']],
  ['Education',           true,  ['School fees', 'Books & Uniforms', 'Extra classes']],
  ['Family & Social',     false, ['Tithe & Offering', 'Gifts', 'Funerals & Donations', 'Family support']],
  ['Personal',            false, ['Clothing', 'Grooming', 'Airtime']],
  ['Financial',           true,  ['Loan repayment', 'Bank charges', 'MoMo fees']],
  ['Savings & Investment',false, ['Susu', 'Fixed deposit', 'Investment']],
  ['Other',               false, []],
];

export const DEFAULT_IN_CATEGORIES = [
  ['Salary', false, []],
  ['Consulting & Lecturing', false, []],
  ['Business income', false, []],
  ['Allowances & Per diem', false, []],
  ['Gifts received', false, []],
  ['Interest & Investment income', false, []],
  ['Refunds & Reimbursements', false, []],
  ['Other income', false, []],
];

// ---------------------------------------------------------------- write path
// Local rows carry two extra underscore-prefixed fields that never leave the
// device: _dirty (needs pushing) and _localOnly (no household yet).

function stamp(row) {
  return { ...row, updated_at: new Date().toISOString(), _dirty: 1 };
}

export async function save(store, row) {
  const record = stamp({ deleted: false, ...row, id: row.id || uid() });
  await db.put(store, record);
  return record;
}

export async function remove(store, id) {
  const existing = await db.get(store, id);
  if (!existing) return;
  await db.put(store, stamp({ ...existing, deleted: true }));
}

export const live = (rows) => rows.filter(r => !r.deleted);

export async function loadAll() {
  const [accounts, categories, people, transactions, budgets, rules] = await Promise.all(
    db.STORES.map(s => db.all(s))
  );
  return {
    accounts: live(accounts).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
    categories: live(categories),
    people: live(people),
    transactions: live(transactions).sort((a, b) =>
      b.occurred_on.localeCompare(a.occurred_on) || b.updated_at.localeCompare(a.updated_at)),
    budgets: live(budgets),
    rules: live(rules),
  };
}

export async function seedIfEmpty(householdId) {
  const existing = await db.all('categories');
  if (existing.length) return false;

  const accounts = DEFAULT_ACCOUNTS.map((a, i) => ({
    id: uid(), household_id: householdId, name: a.name, type: a.type,
    opening_balance: 0, currency: 'GHS', archived: false, sort: i,
  }));

  const categories = [];
  const addTree = (list, flow) => list.forEach(([name, essential, children], i) => {
    const parent = {
      id: uid(), household_id: householdId, name, flow, parent_id: null,
      essential, sort: i,
    };
    categories.push(parent);
    children.forEach((child, j) => categories.push({
      id: uid(), household_id: householdId, name: child, flow,
      parent_id: parent.id, essential, sort: j,
    }));
  });
  addTree(DEFAULT_OUT_CATEGORIES, 'out');
  addTree(DEFAULT_IN_CATEGORIES, 'in');

  for (const a of accounts)   await save('accounts', a);
  for (const c of categories) await save('categories', c);
  return true;
}

/**
 * Normalise a transaction before saving. The transfer rule is the important
 * one: a transfer has a destination account and no category, and every
 * aggregate below skips it. Moving GHS 500 from the bank to MoMo is not
 * income and it is not spending — counting it as either is the single most
 * common way a family budget ends up lying to you.
 */
export function normaliseTransaction(input, householdId) {
  const t = {
    id: input.id || uid(),
    household_id: householdId,
    kind: input.kind,
    amount: Math.abs(input.amount | 0),
    fee: Math.abs(input.fee || 0),
    occurred_on: input.occurred_on || today(),
    account_id: input.account_id || null,
    to_account_id: input.kind === 'transfer' ? (input.to_account_id || null) : null,
    category_id: input.kind === 'transfer' ? null : (input.category_id || null),
    person_id: input.person_id || null,
    payee: (input.payee || '').trim() || null,
    note: (input.note || '').trim() || null,
    tags: input.tags || [],
    source: input.source || 'manual',
    external_ref: input.external_ref || null,
    deleted: false,
  };
  if (!t.amount) throw new Error('Amount must be more than zero.');
  if (!t.account_id) throw new Error('Pick an account.');
  if (t.kind === 'transfer') {
    if (!t.to_account_id) throw new Error('A transfer needs a destination account.');
    if (t.to_account_id === t.account_id) throw new Error('Pick two different accounts.');
  }
  return t;
}

// ----------------------------------------------------------------- analytics
// All of these take the already-loaded arrays so views can slice without
// hitting the database again.

const inRange = (t, from, to) => t.occurred_on >= from && t.occurred_on <= to;

export function filterTransactions(transactions, f = {}) {
  return transactions.filter(t => {
    if (f.from && t.occurred_on < f.from) return false;
    if (f.to && t.occurred_on > f.to) return false;
    if (f.kind && t.kind !== f.kind) return false;
    if (f.accountId && t.account_id !== f.accountId && t.to_account_id !== f.accountId) return false;
    if (f.categoryId && t.category_id !== f.categoryId) return false;
    if (f.personId && t.person_id !== f.personId) return false;
    if (f.text) {
      const hay = `${t.payee || ''} ${t.note || ''} ${(t.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(f.text.toLowerCase())) return false;
    }
    return true;
  });
}

/** Current balance per account. Transfers move money; fees leave it. */
export function accountBalances(accounts, transactions) {
  const balance = new Map(accounts.map(a => [a.id, a.opening_balance || 0]));
  const bump = (id, delta) => { if (balance.has(id)) balance.set(id, balance.get(id) + delta); };
  for (const t of transactions) {
    if (t.kind === 'income')   bump(t.account_id, t.amount - t.fee);
    if (t.kind === 'expense')  bump(t.account_id, -(t.amount + t.fee));
    if (t.kind === 'transfer') { bump(t.account_id, -(t.amount + t.fee)); bump(t.to_account_id, t.amount); }
  }
  return balance;
}

const LIQUID = new Set(['cash', 'momo', 'bank', 'savings']);

export function liquidTotal(accounts, transactions) {
  const balance = accountBalances(accounts, transactions);
  return accounts
    .filter(a => LIQUID.has(a.type) && !a.archived)
    .reduce((sum, a) => sum + (balance.get(a.id) || 0), 0);
}

/**
 * The headline block. Inflow is here not as decoration but because every
 * number worth knowing — net flow, savings rate, how many months of cover you
 * have — is a ratio with income on one side of it.
 */
export function summarise(transactions, from, to, categories = []) {
  const essentialById = new Map(categories.map(c => [c.id, c.essential]));
  let inflow = 0, outflow = 0, fees = 0, essential = 0, count = 0;
  for (const t of transactions) {
    if (!inRange(t, from, to)) continue;
    if (t.kind === 'transfer') { fees += t.fee; continue; }   // internal move, not spending
    count++;
    if (t.kind === 'income') { inflow += t.amount; fees += t.fee; }
    else {
      outflow += t.amount + t.fee;
      fees += t.fee;
      if (essentialById.get(t.category_id)) essential += t.amount + t.fee;
    }
  }
  const net = inflow - outflow;
  return {
    inflow, outflow, net, fees, count,
    essential, discretionary: outflow - essential,
    savingsRate: inflow > 0 ? net / inflow : null,
    essentialShare: outflow > 0 ? essential / outflow : null,
  };
}

/** Totals by category for one flow direction, parents rolled up from children. */
export function categoryTotals(transactions, categories, flow, from, to) {
  const byId = new Map(categories.map(c => [c.id, c]));
  const roll = (id) => {
    let c = byId.get(id);
    while (c && c.parent_id && byId.has(c.parent_id)) c = byId.get(c.parent_id);
    return c;
  };
  const kind = flow === 'in' ? 'income' : 'expense';
  const totals = new Map();
  let uncategorised = 0;
  for (const t of transactions) {
    if (t.kind !== kind || !inRange(t, from, to)) continue;
    const root = t.category_id ? roll(t.category_id) : null;
    if (!root) { uncategorised += t.amount + t.fee; continue; }
    totals.set(root.id, (totals.get(root.id) || 0) + t.amount + (kind === 'expense' ? t.fee : 0));
  }
  const rows = [...totals].map(([id, total]) => ({ id, name: byId.get(id).name, total }));
  if (uncategorised) rows.push({ id: null, name: 'Uncategorised', total: uncategorised });
  return rows.sort((a, b) => b.total - a.total);
}

export function personTotals(transactions, people, from, to) {
  const byId = new Map(people.map(p => [p.id, p]));
  const totals = new Map();
  for (const t of transactions) {
    if (t.kind !== 'expense' || !inRange(t, from, to)) continue;
    const key = t.person_id && byId.has(t.person_id) ? t.person_id : null;
    totals.set(key, (totals.get(key) || 0) + t.amount + t.fee);
  }
  return [...totals]
    .map(([id, total]) => ({ id, name: id ? byId.get(id).name : 'Unassigned', total }))
    .sort((a, b) => b.total - a.total);
}

/** One row per month, oldest first — the series behind the trend charts. */
export function monthlyTrend(transactions, categories, months = 6, endMonth = thisMonth()) {
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const ym = shiftMonth(endMonth, -i);
    const { from, to } = monthRange(ym);
    out.push({ month: ym, label: monthLabel(ym, { short: true }), ...summarise(transactions, from, to, categories) });
  }
  return out;
}

export function budgetProgress(budgets, categories, transactions, ym) {
  const { from, to } = monthRange(ym);
  const spend = new Map();
  for (const t of transactions) {
    if (t.kind !== 'expense' || !inRange(t, from, to) || !t.category_id) continue;
    spend.set(t.category_id, (spend.get(t.category_id) || 0) + t.amount + t.fee);
  }
  const childrenOf = new Map();
  for (const c of categories) {
    if (!c.parent_id) continue;
    if (!childrenOf.has(c.parent_id)) childrenOf.set(c.parent_id, []);
    childrenOf.get(c.parent_id).push(c.id);
  }
  const spentFor = (id) =>
    (spend.get(id) || 0) + (childrenOf.get(id) || []).reduce((s, cid) => s + (spend.get(cid) || 0), 0);

  const byId = new Map(categories.map(c => [c.id, c]));
  return budgets
    .filter(b => b.month === monthStart(ym) && byId.has(b.category_id))
    .map(b => {
      const spent = spentFor(b.category_id);
      return {
        ...b,
        name: byId.get(b.category_id).name,
        spent,
        remaining: b.amount - spent,
        ratio: b.amount > 0 ? spent / b.amount : null,
      };
    })
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
}

/** Liquid cash divided by average monthly outflow — "how long could we coast". */
export function monthsOfCover(accounts, transactions, categories, months = 3) {
  const trend = monthlyTrend(transactions, categories, months);
  const withSpend = trend.filter(m => m.outflow > 0);
  if (!withSpend.length) return null;
  const avg = withSpend.reduce((s, m) => s + m.outflow, 0) / withSpend.length;
  return avg > 0 ? liquidTotal(accounts, transactions) / avg : null;
}

export function topPayees(transactions, from, to, limit = 5) {
  const totals = new Map();
  for (const t of transactions) {
    if (t.kind !== 'expense' || !inRange(t, from, to) || !t.payee) continue;
    totals.set(t.payee, (totals.get(t.payee) || 0) + t.amount + t.fee);
  }
  return [...totals].map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total).slice(0, limit);
}

// ------------------------------------------------------------------ recurring
// Rules do not post silently. They queue what is due and you confirm it —
// a rent that quietly posted while it was actually still unpaid is worse than
// no automation at all.

export function advance(dateIso, cadence) {
  const d = new Date(dateIso + 'T00:00:00Z');
  const step = { weekly: 7, biweekly: 14 };
  if (step[cadence]) { d.setUTCDate(d.getUTCDate() + step[cadence]); return d.toISOString().slice(0, 10); }
  const months = { monthly: 1, quarterly: 3, termly: 4, yearly: 12 }[cadence] || 1;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** Every occurrence of every rule that is due on or before `upTo`. */
export function dueOccurrences(rules, upTo = today()) {
  const due = [];
  for (const rule of rules) {
    let cursor = rule.next_on;
    let guard = 0;
    while (cursor <= upTo && (!rule.ends_on || cursor <= rule.ends_on) && guard++ < 60) {
      due.push({ rule, occurred_on: cursor });
      cursor = advance(cursor, rule.cadence);
    }
  }
  return due.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
}

export function toCSV(transactions, { accounts, categories, people }) {
  const nameOf = (list, id) => (list.find(x => x.id === id) || {}).name || '';
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['date', 'kind', 'amount', 'fee', 'currency', 'account', 'to_account',
                  'category', 'person', 'payee', 'note', 'tags', 'source', 'external_ref'];
  const lines = [header.join(',')];
  for (const t of transactions) {
    lines.push([
      t.occurred_on, t.kind, (t.amount / 100).toFixed(2), (t.fee / 100).toFixed(2), 'GHS',
      nameOf(accounts, t.account_id), nameOf(accounts, t.to_account_id),
      nameOf(categories, t.category_id), nameOf(people, t.person_id),
      t.payee, t.note, (t.tags || []).join(' '), t.source, t.external_ref,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}
