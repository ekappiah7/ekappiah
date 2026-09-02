// App shell: state, routing, and every view. One module because the views all
// read the same in-memory snapshot and the app is small enough that splitting
// it would cost more in plumbing than it saves in file length.

import * as db from './db.js';
import * as S from './store.js';
import * as cloud from './cloud.js';
import * as imp from './importers.js';
import { parseAmount, formatMoney, formatPercent, toInput } from './money.js';
import { renderFlowChart, renderCategoryBars, renderRateTrend, renderStat } from './charts.js';

const state = {
  view: 'home',
  month: S.thisMonth(),
  currency: 'GHS',
  householdId: null,
  user: null,
  sync: { status: 'idle', message: '' },
  filters: { text: '', kind: '', accountId: '', categoryId: '', personId: '', from: '', to: '' },
  insightRange: 6,
  data: { accounts: [], categories: [], people: [], transactions: [], budgets: [], rules: [] },
  importDraft: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const h = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (minor, opts) => formatMoney(minor, state.currency, opts);

function toast(message, tone = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = 'toast show ' + tone;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { node.className = 'toast'; }, 3200);
}

const nameOf = (list, id) => { const found = list.find(x => x.id === id); return found ? found.name : ''; };
const catById = (id) => state.data.categories.find(c => c.id === id);

// --------------------------------------------------------------- data loading

async function refresh({ rerender = true } = {}) {
  state.data = await S.loadAll();
  if (rerender) render();
}

async function trySync({ quiet = true } = {}) {
  state.sync = { status: 'syncing', message: '' };
  paintSyncBadge();
  const result = await cloud.sync();
  if (result.ok) {
    state.sync = { status: 'synced', message: `${result.pushed} up / ${result.pulled} down` };
    if (result.pulled) await refresh();
  } else {
    const status = result.reason === 'error' ? 'error'
      : result.reason === 'unreachable' ? 'unreachable' : 'local';
    state.sync = { status, message: result.message || result.reason };
    if (!quiet && (result.reason === 'error' || result.reason === 'unreachable')) {
      toast(result.message || 'Sync failed', 'bad');
    }
  }
  paintSyncBadge();
  return result;
}

const THEMES = ['system', 'light', 'dark'];

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const button = $('#theme-btn');
  if (button) {
    const label = { system: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }[theme];
    button.textContent = label;
    button.setAttribute('aria-label', `Theme: ${theme}. Tap to change.`);
  }
  const meta = document.querySelector('meta[name="theme-color"]:not([media])')
    || Object.assign(document.createElement('meta'), { name: 'theme-color' });
  if (!meta.parentNode) document.head.appendChild(meta);
  const dark = theme === 'dark' ||
    (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  meta.setAttribute('content', dark ? '#2a1810' : '#f5eee0');
}

function paintSyncBadge() {
  const badge = $('#sync-badge');
  if (!badge) return;
  const labels = {
    syncing: 'Syncing…', synced: 'Synced', error: 'Sync error',
    unreachable: 'No Firebase', local: 'On this device', idle: '',
  };
  badge.textContent = labels[state.sync.status] || '';
  badge.dataset.status = state.sync.status;
  badge.title = state.sync.message || '';
}

// --------------------------------------------------------------- form helpers

function accountOptions(selected, { allowBlank = false } = {}) {
  return (allowBlank ? '<option value="">All accounts</option>' : '') +
    state.data.accounts.filter(a => !a.archived || a.id === selected)
      .map(a => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${h(a.name)}</option>`).join('');
}

function categoryOptions(flow, selected, { allowBlank = true } = {}) {
  const all = state.data.categories.filter(c => c.flow === flow);
  const parents = all.filter(c => !c.parent_id).sort((a, b) => a.sort - b.sort);
  let html = allowBlank ? '<option value="">— no category —</option>' : '';
  for (const parent of parents) {
    const children = all.filter(c => c.parent_id === parent.id).sort((a, b) => a.sort - b.sort);
    const pick = (c, indent) =>
      `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${indent}${h(c.name)}</option>`;
    if (!children.length) { html += pick(parent, ''); continue; }
    html += `<optgroup label="${h(parent.name)}">` + pick(parent, '') +
            children.map(c => pick(c, '   ')).join('') + '</optgroup>';
  }
  return html;
}

function personOptions(selected, { blankLabel = '— nobody in particular —' } = {}) {
  return `<option value="">${blankLabel}</option>` + state.data.people
    .map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${h(p.name)}</option>`).join('');
}

function monthNav(month) {
  return `<div class="month-nav">
    <button class="icon-btn" data-action="month" data-delta="-1" aria-label="Previous month">‹</button>
    <strong>${h(S.monthLabel(month))}</strong>
    <button class="icon-btn" data-action="month" data-delta="1" aria-label="Next month"
      ${month >= S.thisMonth() ? 'disabled' : ''}>›</button>
  </div>`;
}

// ------------------------------------------------------------------ home view

function viewHome() {
  const { from, to } = S.monthRange(state.month);
  const { transactions, categories, accounts, budgets } = state.data;
  const sum = S.summarise(transactions, from, to, categories);
  const balances = S.accountBalances(accounts, transactions);
  const cover = S.monthsOfCover(accounts, transactions, categories);
  const budgetRows = S.budgetProgress(budgets, categories, transactions, state.month).slice(0, 4);
  const recent = transactions.filter(t => t.occurred_on <= to).slice(0, 8);

  return `
  ${monthNav(state.month)}

  <section class="hero">
    <span class="hero-label">Net this month</span>
    <div class="hero-value ${sum.net >= 0 ? 'is-positive' : sum.net < 0 ? 'is-negative' : ''}"
         data-len="${money(sum.net, { signed: true }).length}">${money(sum.net, { signed: true })}</div>
    <span class="hero-note">${heroNote(sum)}</span>
    <div class="hero-split">
      <div class="hero-cell">
        <span class="hero-cell-label"><i class="swatch-sm in"></i>Money in</span>
        <span class="hero-cell-value">${money(sum.inflow, { compact: true })}</span>
      </div>
      <div class="hero-cell">
        <span class="hero-cell-label"><i class="swatch-sm out"></i>Money out</span>
        <span class="hero-cell-value">${money(sum.outflow, { compact: true })}</span>
      </div>
      <div class="hero-cell">
        <span class="hero-cell-label">Saved</span>
        <span class="hero-cell-value">${sum.savingsRate === null ? '—' : formatPercent(sum.savingsRate)}</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Money in vs money out</h2>
    <p class="card-sub">Transfers between your own accounts are excluded — moving cash is not income or spending.</p>
    <div class="viz" id="viz-flow"></div>
  </section>

  <section class="card">
    <h2>Where you stand</h2>
    <ul class="kv">
      <li><span>Liquid balance</span><strong>${money(S.liquidTotal(accounts, transactions))}</strong></li>
      <li><span>Essentials share of spending</span><strong>${sum.essentialShare === null ? '—' : formatPercent(sum.essentialShare)}</strong></li>
      <li><span>Months of cover</span><strong>${cover === null ? '—' : cover.toFixed(1)}</strong></li>
      <li><span>Fees paid this month</span><strong>${money(sum.fees)}</strong></li>
    </ul>
  </section>

  <section class="card">
    <h2>Accounts</h2>
    <ul class="account-list">
      ${accounts.filter(a => !a.archived).map(a => `
        <li><span class="acct-name"><i class="dot dot-${h(a.type)}"></i>${h(a.name)}</span>
        <strong class="${(balances.get(a.id) || 0) < 0 ? 'is-negative' : ''}">${money(balances.get(a.id) || 0)}</strong></li>`).join('')
        || '<li class="muted">No accounts yet — add them in Settings.</li>'}
    </ul>
  </section>

  ${budgetRows.length ? `<section class="card">
    <h2>Budgets</h2>
    ${budgetRows.map(b => budgetBar(b)).join('')}
    <button class="link-btn" data-action="go" data-view="budgets">All budgets →</button>
  </section>` : ''}

  <section class="card">
    <h2>Recent activity</h2>
    ${recent.length ? `<ul class="txn-list">${recent.map(txnRow).join('')}</ul>`
      : '<p class="muted">Nothing recorded yet. Tap + to add your first entry.</p>'}
    <button class="link-btn" data-action="go" data-view="ledger">Full ledger →</button>
  </section>`;
}

/** A plain-language read of the month, so the hero number is not alone. */
function heroNote(sum) {
  if (!sum.count) return 'Nothing recorded yet this month.';
  if (!sum.inflow) return `${money(sum.outflow)} spent, no income recorded yet.`;
  if (sum.net >= 0) return `${money(sum.inflow)} in, ${money(sum.outflow)} out — you kept ${formatPercent(sum.savingsRate)}.`;
  return `${money(sum.outflow)} out against ${money(sum.inflow)} in — ${money(-sum.net)} more than came in.`;
}

function budgetBar(b) {
  const ratio = b.ratio === null ? 0 : Math.min(b.ratio, 1.4);
  const tone = b.ratio === null ? '' : b.ratio > 1 ? 'over' : b.ratio > 0.85 ? 'near' : 'ok';
  return `<div class="budget">
    <div class="budget-head"><span>${h(b.name)}</span>
      <span class="${tone === 'over' ? 'is-negative' : ''}">${money(b.spent)} of ${money(b.amount)}</span></div>
    <div class="budget-track"><div class="budget-fill ${tone}" style="width:${Math.min(ratio, 1) * 100}%"></div></div>
    <div class="budget-foot muted">${b.remaining >= 0 ? money(b.remaining) + ' left' : money(-b.remaining) + ' over'}</div>
  </div>`;
}

function txnRow(t) {
  const sign = t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : '';
  const label = t.kind === 'transfer'
    ? `${nameOf(state.data.accounts, t.account_id)} → ${nameOf(state.data.accounts, t.to_account_id)}`
    : (t.payee || nameOf(state.data.categories, t.category_id) || 'Untitled');
  const meta = [
    t.kind === 'transfer' ? 'Transfer' : nameOf(state.data.categories, t.category_id),
    nameOf(state.data.accounts, t.account_id),
    nameOf(state.data.people, t.person_id),
  ].filter(Boolean).join(' · ');
  return `<li class="txn" data-action="edit-txn" data-id="${t.id}" tabindex="0" role="button">
    <span class="txn-main"><span class="txn-label">${h(label)}</span><span class="txn-meta">${h(meta)}</span></span>
    <span class="txn-right"><span class="txn-amount kind-${t.kind}">${sign}${money(t.amount)}</span>
    <span class="txn-date">${h(t.occurred_on.slice(5))}</span></span>
  </li>`;
}

// ---------------------------------------------------------------- ledger view

function viewLedger() {
  const f = state.filters;
  const rows = S.filterTransactions(state.data.transactions, f);
  const totals = rows.reduce((acc, t) => {
    if (t.kind === 'income') acc.in += t.amount;
    if (t.kind === 'expense') acc.out += t.amount + t.fee;
    return acc;
  }, { in: 0, out: 0 });

  const groups = new Map();
  for (const t of rows) {
    if (!groups.has(t.occurred_on)) groups.set(t.occurred_on, []);
    groups.get(t.occurred_on).push(t);
  }

  return `
  <section class="card filters">
    <input type="search" id="f-text" placeholder="Search payee, note or tag" value="${h(f.text)}" data-filter="text">
    <div class="filter-row">
      <select data-filter="kind">
        <option value="">All kinds</option>
        ${['expense', 'income', 'transfer'].map(k =>
          `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}
      </select>
      <select data-filter="accountId">${accountOptions(f.accountId, { allowBlank: true })}</select>
      <select data-filter="personId">${personOptions(f.personId, { blankLabel: 'Everyone' })}</select>
    </div>
    <div class="filter-row">
      <label>From <input type="date" data-filter="from" value="${h(f.from)}"></label>
      <label>To <input type="date" data-filter="to" value="${h(f.to)}"></label>
      <button class="ghost-btn" data-action="clear-filters">Clear</button>
    </div>
    <div class="filter-summary">
      <span>${rows.length} entries</span>
      <span class="kind-income">+${money(totals.in)}</span>
      <span class="kind-expense">−${money(totals.out)}</span>
      <span><strong>${money(totals.in - totals.out, { signed: true })}</strong></span>
      <button class="ghost-btn" data-action="export-csv">Export CSV</button>
    </div>
  </section>

  ${rows.length ? [...groups].map(([date, items]) => `
    <section class="card day">
      <h3 class="day-head">${h(new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</h3>
      <ul class="txn-list">${items.map(txnRow).join('')}</ul>
    </section>`).join('')
    : '<section class="card"><p class="muted">Nothing matches those filters.</p></section>'}`;
}

// -------------------------------------------------------------- insights view

function viewInsights() {
  const months = state.insightRange;
  const endMonth = state.month;
  const first = S.shiftMonth(endMonth, -(months - 1));
  const from = S.monthRange(first).from;
  const to = S.monthRange(endMonth).to;
  const { transactions, categories, people, accounts } = state.data;
  const sum = S.summarise(transactions, from, to, categories);
  const perMonth = months || 1;

  return `
  ${monthNav(endMonth)}
  <div class="seg" role="group" aria-label="Period length">
    ${[3, 6, 12].map(n => `<button class="${months === n ? 'is-active' : ''}" data-action="range" data-months="${n}">${n} months</button>`).join('')}
  </div>

  <div class="stat-grid">
    ${renderStat(money(sum.inflow / perMonth, { compact: true }), 'Avg income / month', 'tone-in')}
    ${renderStat(money(sum.outflow / perMonth, { compact: true }), 'Avg spending / month', 'tone-out')}
    ${renderStat(sum.savingsRate === null ? '—' : formatPercent(sum.savingsRate), 'Saved over period')}
    ${renderStat((S.monthsOfCover(accounts, transactions, categories, months) || 0).toFixed(1), 'Months of cover')}
  </div>

  <section class="card">
    <h2>Savings rate</h2>
    <p class="card-sub">What share of everything that came in was still there at month end.</p>
    <div class="viz" id="viz-rate"></div>
  </section>

  <section class="card">
    <h2>Money in vs money out</h2>
    <div class="viz" id="viz-flow"></div>
  </section>

  <section class="card">
    <h2>Where the money went</h2>
    <div class="viz" id="viz-out"></div>
  </section>

  <section class="card">
    <h2>Where the money came from</h2>
    <p class="card-sub">Income concentrated in one source is a risk worth seeing.</p>
    <div class="viz" id="viz-in"></div>
  </section>

  <section class="card">
    <h2>Needs vs wants</h2>
    <ul class="kv">
      <li><span>Essentials</span><strong>${money(sum.essential)} (${sum.essentialShare === null ? '—' : formatPercent(sum.essentialShare)})</strong></li>
      <li><span>Everything else</span><strong>${money(sum.discretionary)}</strong></li>
      <li><span>Fees and charges</span><strong>${money(sum.fees)}</strong></li>
    </ul>
    <p class="card-sub">Mark a category essential in Settings to move it into the first line.</p>
  </section>

  <section class="card">
    <h2>Who spent it</h2>
    <div class="viz" id="viz-people"></div>
  </section>

  <section class="card">
    <h2>Most-paid</h2>
    <ul class="kv">${S.topPayees(transactions, from, to, 6).map(p =>
      `<li><span>${h(p.name)}</span><strong>${money(p.total)}</strong></li>`).join('') || '<li class="muted">No named payees yet.</li>'}</ul>
  </section>`;
}

function paintInsightCharts() {
  const months = state.insightRange;
  const { transactions, categories, people } = state.data;
  const first = S.shiftMonth(state.month, -(months - 1));
  const from = S.monthRange(first).from;
  const to = S.monthRange(state.month).to;
  const series = S.monthlyTrend(transactions, categories, months, state.month);

  if ($('#viz-rate')) renderRateTrend($('#viz-rate'), series);
  if ($('#viz-flow')) renderFlowChart($('#viz-flow'), series, state.currency);
  if ($('#viz-out')) renderCategoryBars($('#viz-out'), S.categoryTotals(transactions, categories, 'out', from, to), state.currency);
  if ($('#viz-in')) renderCategoryBars($('#viz-in'), S.categoryTotals(transactions, categories, 'in', from, to), state.currency);
  if ($('#viz-people')) renderCategoryBars($('#viz-people'), S.personTotals(transactions, people, from, to), state.currency);
}

// --------------------------------------------------------------- budgets view

function viewBudgets() {
  const { categories, budgets, transactions } = state.data;
  const rows = S.budgetProgress(budgets, categories, transactions, state.month);
  const budgeted = rows.reduce((s, b) => s + b.amount, 0);
  const spent = rows.reduce((s, b) => s + b.spent, 0);
  const { from, to } = S.monthRange(state.month);
  const income = S.summarise(transactions, from, to, categories).inflow;

  return `
  ${monthNav(state.month)}
  <section class="card">
    <div class="stat-grid tight">
      ${renderStat(money(budgeted, { compact: true }), 'Budgeted')}
      ${renderStat(money(spent, { compact: true }), 'Spent')}
      ${renderStat(money(budgeted - spent, { compact: true, signed: true }), 'Left')}
      ${renderStat(income ? formatPercent(budgeted / income) : '—', 'Of this month’s income')}
    </div>
    ${income && budgeted > income ? '<p class="warn">You have budgeted more than came in this month.</p>' : ''}
  </section>

  <section class="card">
    <h2>Set a budget</h2>
    <form class="row-form" data-form="budget">
      <select name="category_id" required>${categoryOptions('out', '', { allowBlank: false })}</select>
      <input name="amount" inputmode="decimal" placeholder="Amount" required>
      <button class="primary-btn" type="submit">Save</button>
    </form>
    <p class="card-sub">Saving over an existing category replaces that month’s figure.</p>
  </section>

  <section class="card">
    <h2>${h(S.monthLabel(state.month))}</h2>
    ${rows.length ? rows.map(b => `<div class="budget-item">${budgetBar(b)}
      <button class="ghost-btn" data-action="del-budget" data-id="${b.id}">Remove</button></div>`).join('')
      : '<p class="muted">No budgets set for this month yet.</p>'}
    ${rows.length ? '' : previousMonthCopyPrompt()}
  </section>`;
}

function previousMonthCopyPrompt() {
  const previous = S.shiftMonth(state.month, -1);
  const has = state.data.budgets.some(b => b.month === S.monthStart(previous));
  return has ? `<button class="ghost-btn" data-action="copy-budgets">Copy ${h(S.monthLabel(previous))}’s budgets</button>` : '';
}

// ------------------------------------------------------------- recurring view

function viewRecurring() {
  const due = S.dueOccurrences(state.data.rules);
  return `
  <section class="card">
    <h2>Due now</h2>
    <p class="card-sub">Nothing posts on its own. Rent that quietly recorded itself while it was still unpaid is worse than no automation.</p>
    ${due.length ? `<ul class="txn-list">${due.map(d => `
      <li class="txn">
        <span class="txn-main"><span class="txn-label">${h(d.rule.label)}</span>
        <span class="txn-meta">${h(d.occurred_on)} · ${h(d.rule.cadence)}</span></span>
        <span class="txn-right">
          <span class="txn-amount kind-${h(d.rule.template.kind)}">${money(d.rule.template.amount)}</span>
          <span class="row-actions">
            <button class="mini-btn" data-action="post-due" data-id="${d.rule.id}" data-date="${d.occurred_on}">Post</button>
            <button class="mini-btn ghost" data-action="skip-due" data-id="${d.rule.id}" data-date="${d.occurred_on}">Skip</button>
          </span></span>
      </li>`).join('')}</ul>` : '<p class="muted">Nothing due.</p>'}
  </section>

  <section class="card">
    <h2>New rule</h2>
    <form class="stack-form" data-form="rule">
      <label>Label <input name="label" required placeholder="Rent, salary, school fees…"></label>
      <div class="filter-row">
        <label>Kind <select name="kind">
          <option value="expense">Expense</option><option value="income">Income</option></select></label>
        <label>Amount <input name="amount" inputmode="decimal" required></label>
      </div>
      <div class="filter-row">
        <label>Account <select name="account_id">${accountOptions('')}</select></label>
        <label>Category <select name="category_id">${categoryOptions('out', '')}</select></label>
      </div>
      <div class="filter-row">
        <label>Every <select name="cadence">
          ${['monthly', 'weekly', 'biweekly', 'quarterly', 'termly', 'yearly'].map(c =>
            `<option value="${c}">${c}</option>`).join('')}</select></label>
        <label>Starting <input type="date" name="next_on" value="${S.today()}"></label>
      </div>
      <button class="primary-btn" type="submit">Add rule</button>
    </form>
  </section>

  <section class="card">
    <h2>Rules</h2>
    ${state.data.rules.length ? `<ul class="plain-list">${state.data.rules.map(r => `
      <li><span>${h(r.label)} · ${h(r.cadence)} · next ${h(r.next_on)}</span>
      <button class="ghost-btn" data-action="del-rule" data-id="${r.id}">Delete</button></li>`).join('')}</ul>`
      : '<p class="muted">No rules yet.</p>'}
  </section>`;
}

// ---------------------------------------------------------------- import view

function viewImport() {
  const draft = state.importDraft;
  return `
  <section class="card">
    <h2>Paste MoMo messages</h2>
    <p class="card-sub">Copy the SMS thread from your phone and paste it here. Anything unreadable is listed rather than silently dropped.</p>
    <form class="stack-form" data-form="sms">
      <label>Into account <select name="account_id">${accountOptions((state.data.accounts.find(a => a.type === 'momo') || {}).id)}</select></label>
      <textarea name="blob" rows="6" placeholder="Payment received for GHS 50.00 from …"></textarea>
      <button class="primary-btn" type="submit">Read messages</button>
    </form>
  </section>

  <section class="card">
    <h2>Bank or MoMo statement (CSV)</h2>
    <form class="stack-form" data-form="csv">
      <label>Into account <select name="account_id">${accountOptions((state.data.accounts.find(a => a.type === 'bank') || {}).id)}</select></label>
      <input type="file" name="file" accept=".csv,.txt,text/csv">
      <label class="check"><input type="checkbox" name="dayfirst" checked> Dates are day/month/year</label>
      <button class="primary-btn" type="submit">Read file</button>
    </form>
  </section>

  ${draft ? importPreview(draft) : ''}`;
}

function importPreview(draft) {
  return `
  <section class="card" id="import-preview">
    <h2>Review ${draft.rows.length} entries</h2>
    <p class="card-sub">
      ${draft.duplicates} already in your ledger were left out.
      ${draft.skipped.length ? draft.skipped.length + ' message(s) could not be read.' : ''}
    </p>
    <div class="table-wrap">
      <table class="preview">
        <thead><tr><th><input type="checkbox" data-action="toggle-all" checked></th>
          <th>Date</th><th>Kind</th><th>Amount</th><th>Payee</th><th>Category</th></tr></thead>
        <tbody>
          ${draft.rows.map((r, i) => `<tr>
            <td><input type="checkbox" data-row="${i}" ${r._include === false ? '' : 'checked'}></td>
            <td><input type="date" data-row="${i}" data-field="occurred_on" value="${h(r.occurred_on)}"></td>
            <td><select data-row="${i}" data-field="kind">
              <option value="expense" ${r.kind === 'expense' ? 'selected' : ''}>Expense</option>
              <option value="income" ${r.kind === 'income' ? 'selected' : ''}>Income</option></select></td>
            <td class="num">${money(r.amount)}${r.fee ? `<span class="muted"> +${money(r.fee)} fee</span>` : ''}</td>
            <td>${h(r.payee || '')}</td>
            <td><select data-row="${i}" data-field="category_id">${categoryOptions(r.kind === 'income' ? 'in' : 'out', r.category_id)}</select></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="row-actions">
      <button class="primary-btn" data-action="commit-import">Add selected to ledger</button>
      <button class="ghost-btn" data-action="cancel-import">Discard</button>
    </div>
    ${draft.skipped.length ? `<details class="skipped"><summary>${draft.skipped.length} unread message(s)</summary>
      <ul>${draft.skipped.map(s => `<li><code>${h(s.message.slice(0, 160))}</code> — ${h(s.reason)}</li>`).join('')}</ul>
    </details>` : ''}
  </section>`;
}

// -------------------------------------------------------------- settings view

function viewSettings() {
  const { accounts, categories, people } = state.data;
  return `
  <section class="card">
    <h2>Family sharing</h2>
    <div id="cloud-panel">Loading…</div>
  </section>

  <section class="card">
    <h2>Accounts</h2>
    <form class="row-form" data-form="account">
      <input name="name" placeholder="Account name" required>
      <select name="type">${['cash', 'momo', 'bank', 'savings', 'card', 'loan', 'other']
        .map(t => `<option value="${t}">${t}</option>`).join('')}</select>
      <input name="opening_balance" inputmode="decimal" placeholder="Opening balance">
      <button class="primary-btn" type="submit">Add</button>
    </form>
    <ul class="plain-list">${accounts.map(a => `<li>
      <span>${h(a.name)} <span class="muted">${h(a.type)} · opens at ${money(a.opening_balance)}</span></span>
      <button class="ghost-btn" data-action="del-account" data-id="${a.id}">Delete</button></li>`).join('')}</ul>
  </section>

  <section class="card">
    <h2>People</h2>
    <p class="card-sub">Tag who a spend was for. It is the difference between “GHS 800 on transport” and “GHS 800 taking the kids to school”.</p>
    <form class="row-form" data-form="person">
      <input name="name" placeholder="Name" required>
      <button class="primary-btn" type="submit">Add</button>
    </form>
    <ul class="plain-list">${people.map(p => `<li><span>${h(p.name)}</span>
      <button class="ghost-btn" data-action="del-person" data-id="${p.id}">Delete</button></li>`).join('')
      || '<li class="muted">Nobody added yet.</li>'}</ul>
  </section>

  <section class="card">
    <h2>Categories</h2>
    <form class="row-form" data-form="category">
      <input name="name" placeholder="Category name" required>
      <select name="flow"><option value="out">Spending</option><option value="in">Income</option></select>
      <select name="parent_id"><option value="">Top level</option>
        ${categories.filter(c => !c.parent_id).map(c => `<option value="${c.id}">${h(c.name)} (${c.flow})</option>`).join('')}</select>
      <button class="primary-btn" type="submit">Add</button>
    </form>
    ${['out', 'in'].map(flow => `
      <h3>${flow === 'out' ? 'Spending' : 'Income'}</h3>
      <ul class="plain-list">${categories.filter(c => c.flow === flow && !c.parent_id).sort((a, b) => a.sort - b.sort).map(parent => `
        <li><span>${h(parent.name)}
          <label class="check inline"><input type="checkbox" data-action="essential" data-id="${parent.id}"
            ${parent.essential ? 'checked' : ''}> essential</label>
          <span class="muted">${h(categories.filter(c => c.parent_id === parent.id).map(c => c.name).join(', '))}</span></span>
          <button class="ghost-btn" data-action="del-category" data-id="${parent.id}">Delete</button></li>`).join('')}
      </ul>`).join('')}
  </section>

  <section class="card">
    <h2>Your data</h2>
    <div class="row-actions">
      <button class="ghost-btn" data-action="export-csv">Export all as CSV</button>
      <button class="ghost-btn" data-action="export-json">Export backup (JSON)</button>
      <button class="ghost-btn danger" data-action="wipe">Erase this device</button>
    </div>
    <p class="card-sub">Erasing only clears this phone or laptop. If you are signed in, the next sync pulls everything back.</p>
  </section>`;
}

/**
 * Adopting a different household clears what is on this device. That is the
 * right call when joining somebody else's ledger, but it must never happen
 * silently to someone who has real entries here.
 */
async function confirmReplaceLocal(targetId = null) {
  const previous = await cloud.currentLocalHousehold();
  if (!previous || previous === targetId) return true;
  const count = state.data.transactions.length;
  if (!count) return true;
  return confirm(
    `This device has ${count} entries that are not part of that household.\n\n` +
    'Switching replaces them with the household\'s ledger. Export them first from ' +
    'Settings → Your data if you want to keep a copy.\n\nContinue?');
}

async function paintCloudPanel() {
  const panel = $('#cloud-panel');
  if (!panel) return;
  const config = await cloud.getConfig();
  if (!config.config) {
    panel.innerHTML = `
      <p class="card-sub">The app works on its own. Add a Firebase project to share one ledger across the family’s phones. Setup steps are in <code>README.md</code>.</p>
      <form class="stack-form" data-form="firebase">
        <label>Firebase web config
          <textarea name="config" rows="7" required
            placeholder="Paste the whole block from the Firebase console:&#10;&#10;const firebaseConfig = {&#10;  apiKey: &quot;…&quot;,&#10;  authDomain: &quot;your-app.firebaseapp.com&quot;,&#10;  projectId: &quot;your-app&quot;,&#10;  appId: &quot;1:…&quot;&#10;};"></textarea>
        </label>
        <button class="primary-btn" type="submit">Connect</button>
      </form>`;
    return;
  }
  // Fetching the SDK and restoring a session both take a moment on a slow
  // connection. Say so, rather than leaving the previous panel on screen
  // looking like the click did nothing.
  panel.innerHTML = '<p class="card-sub">Connecting to Firebase…</p>';

  const user = await cloud.currentUser().catch(() => null);
  state.user = user;

  // A configured project whose SDK will not load is a different problem from
  // being signed out, and saying "sign in" would send someone hunting for a
  // password that was never the issue.
  const blocked = cloud.sdkError();
  if (!user && blocked) {
    panel.innerHTML = `
      <p class="warn">${h(blocked)}</p>
      <p class="card-sub">Your ledger is safe on this device and will sync once Firebase is reachable.</p>
      <div class="row-actions">
        <button class="primary-btn" data-action="retry-cloud">Try again</button>
        <button class="ghost-btn" data-action="forget-firebase">Use a different project</button>
      </div>`;
    return;
  }

  if (!user) {
    panel.innerHTML = `
      <form class="stack-form" data-form="signin">
        <label>Email <input name="email" type="email" required autocomplete="username"></label>
        <label>Password <input name="password" type="password" required minlength="8" autocomplete="current-password"></label>
        <div class="row-actions">
          <button class="primary-btn" type="submit" value="in" name="mode">Sign in</button>
          <button class="ghost-btn" type="submit" value="up" name="mode">Create account</button>
        </div>
      </form>
      <button class="link-btn" data-action="forget-firebase">Use a different project</button>`;
    return;
  }
  let households = [];
  let error = '';
  try { households = await cloud.listHouseholds(); }
  catch (err) { error = err.message || String(err); }
  const current = households.find(x => x.id === config.householdId);
  panel.innerHTML = `
    <p class="signed-in">Signed in as <strong>${h(user.email)}</strong>
      <button class="link-btn" data-action="signout">Sign out</button></p>
    ${error ? `<p class="warn">${h(error)}</p>` : ''}
    ${config.config ? `<p class="card-sub">Project <code>${h(config.config.projectId)}</code></p>` : ''}
    ${current ? `<p class="kv-inline">Household <strong>${h(current.name)}</strong> ·
      invite code <code class="code-chip">${h(current.invite_code)}</code>
      <button class="mini-btn" data-action="copy-code" data-code="${h(current.invite_code)}">Copy</button></p>` : ''}
    ${households.length ? `<label>Active household
      <select data-action="pick-household">${households.map(x =>
        `<option value="${x.id}" ${x.id === config.householdId ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></label>` : ''}
    <div class="filter-row">
      <form class="row-form" data-form="new-household">
        <input name="name" placeholder="New household name" required>
        <button class="ghost-btn" type="submit">Create</button>
      </form>
      <form class="row-form" data-form="join-household">
        <input name="code" placeholder="Invite code" required>
        <button class="ghost-btn" type="submit">Join</button>
      </form>
    </div>
    <div class="row-actions">
      <button class="primary-btn" data-action="sync-now">Sync now</button>
      <span class="muted" id="last-sync"></span>
    </div>`;
  db.meta.get('last_sync').then(v => {
    const node = $('#last-sync');
    if (node && v) node.textContent = 'Last sync ' + new Date(v).toLocaleString('en-GB');
  });
}

// ---------------------------------------------------------- transaction sheet

function openSheet(txn) {
  const isNew = !txn;
  const t = txn || { kind: 'expense', occurred_on: S.today(), amount: 0, fee: 0,
                     account_id: (state.data.accounts[0] || {}).id };
  const dialog = $('#sheet');
  dialog.innerHTML = `
  <form method="dialog" class="sheet-form" data-form="txn" data-id="${t.id || ''}">
    <header class="sheet-head">
      <h2>${isNew ? 'New entry' : 'Edit entry'}</h2>
      <button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button>
    </header>

    <div class="seg kind-seg" role="group" aria-label="Kind">
      ${['expense', 'income', 'transfer'].map(k =>
        `<button type="button" class="${t.kind === k ? 'is-active' : ''}" data-kind="${k}">
          ${k === 'expense' ? 'Money out' : k === 'income' ? 'Money in' : 'Transfer'}</button>`).join('')}
    </div>
    <input type="hidden" name="kind" value="${t.kind}">

    <label class="amount-field">Amount
      <input name="amount" inputmode="decimal" required autocomplete="off"
        value="${t.amount ? toInput(t.amount) : ''}" placeholder="0.00">
    </label>

    <div class="filter-row">
      <label>Date <input type="date" name="occurred_on" value="${h(t.occurred_on)}" required></label>
      <label>Fee <input name="fee" inputmode="decimal" value="${t.fee ? toInput(t.fee) : ''}" placeholder="0.00"></label>
    </div>

    <label id="acct-from-label">${t.kind === 'transfer' ? 'From account' : 'Account'}
      <select name="account_id" required>${accountOptions(t.account_id)}</select></label>
    <label id="acct-to-label" ${t.kind === 'transfer' ? '' : 'hidden'}>To account
      <select name="to_account_id">${accountOptions(t.to_account_id)}</select></label>
    <label id="cat-label" ${t.kind === 'transfer' ? 'hidden' : ''}>Category
      <select name="category_id">${categoryOptions(t.kind === 'income' ? 'in' : 'out', t.category_id)}</select></label>

    <div class="filter-row">
      <label>Payee <input name="payee" value="${h(t.payee || '')}" placeholder="Shop, person, employer"></label>
      <label>For whom <select name="person_id">${personOptions(t.person_id)}</select></label>
    </div>
    <label>Note <input name="note" value="${h(t.note || '')}" placeholder="Optional"></label>

    <footer class="sheet-foot">
      ${isNew ? '' : `<button type="button" class="ghost-btn danger" data-action="del-txn" data-id="${t.id}">Delete</button>`}
      <span class="spacer"></span>
      ${isNew ? '<button type="submit" class="ghost-btn" name="again" value="1">Save &amp; add another</button>' : ''}
      <button type="submit" class="primary-btn">Save</button>
    </footer>
  </form>`;

  dialog.querySelectorAll('.kind-seg button').forEach(button => {
    button.addEventListener('click', () => {
      const kind = button.dataset.kind;
      dialog.querySelectorAll('.kind-seg button').forEach(b => b.classList.toggle('is-active', b === button));
      dialog.querySelector('input[name=kind]').value = kind;
      $('#acct-to-label', dialog).hidden = kind !== 'transfer';
      $('#cat-label', dialog).hidden = kind === 'transfer';
      $('#acct-from-label', dialog).firstChild.textContent =
        kind === 'transfer' ? 'From account\n      ' : 'Account\n      ';
      $('select[name=category_id]', dialog).innerHTML =
        categoryOptions(kind === 'income' ? 'in' : 'out', '');
    });
  });

  dialog.showModal();
  setTimeout(() => { const f = $('input[name=amount]', dialog); if (f) f.focus(); }, 40);
}

async function saveSheet(form, again) {
  const data = Object.fromEntries(new FormData(form));
  try {
    const txn = S.normaliseTransaction({
      id: form.dataset.id || undefined,
      kind: data.kind,
      amount: parseAmount(data.amount),
      fee: parseAmount(data.fee) || 0,
      occurred_on: data.occurred_on,
      account_id: data.account_id,
      to_account_id: data.to_account_id,
      category_id: data.category_id,
      person_id: data.person_id,
      payee: data.payee,
      note: data.note,
    }, state.householdId);
    await S.save('transactions', txn);
    toast('Saved');
    await refresh();
    trySync();
    if (again) openSheet(null);
  } catch (err) {
    toast(err.message, 'bad');
    throw err;
  }
}

// ------------------------------------------------------------------- rendering

const VIEWS = {
  home: viewHome, ledger: viewLedger, insights: viewInsights,
  budgets: viewBudgets, recurring: viewRecurring, import: viewImport, settings: viewSettings,
};

const TITLES = {
  home: 'Overview', ledger: 'Ledger', insights: 'Insights',
  budgets: 'Budgets', recurring: 'Recurring', import: 'Import', settings: 'Settings',
};

function render() {
  $('#view-title').textContent = TITLES[state.view];
  $('#view').innerHTML = (VIEWS[state.view] || viewHome)();
  document.querySelectorAll('.tab').forEach(tab =>
    tab.classList.toggle('is-active', tab.dataset.view === state.view));
  document.querySelectorAll('[data-menu-view]').forEach(item =>
    item.classList.toggle('is-active', item.dataset.menuView === state.view));

  if (state.view === 'home') {
    renderFlowChart($('#viz-flow'), S.monthlyTrend(state.data.transactions, state.data.categories, 6, state.month), state.currency);
  }
  if (state.view === 'insights') paintInsightCharts();
  if (state.view === 'settings') paintCloudPanel();
  paintSyncBadge();
  window.scrollTo({ top: 0 });
}

function go(view) {
  state.view = view;
  location.hash = view;
  $('#menu').hidden = true;
  render();
}

// --------------------------------------------------------------------- actions

function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const ACTIONS = {
  go: (el) => go(el.dataset.view),
  month: (el) => {
    const next = S.shiftMonth(state.month, Number(el.dataset.delta));
    if (next > S.thisMonth()) return;
    state.month = next; render();
  },
  range: (el) => { state.insightRange = Number(el.dataset.months); render(); },
  'edit-txn': (el) => openSheet(state.data.transactions.find(t => t.id === el.dataset.id)),
  'del-txn': async (el) => {
    if (!confirm('Delete this entry?')) return;
    await S.remove('transactions', el.dataset.id);
    $('#sheet').close();
    await refresh(); trySync(); toast('Deleted');
  },
  'clear-filters': async () => {
    state.filters = { text: '', kind: '', accountId: '', categoryId: '', personId: '', from: '', to: '' };
    render();
  },
  'export-csv': () => {
    const rows = state.view === 'ledger'
      ? S.filterTransactions(state.data.transactions, state.filters)
      : state.data.transactions;
    download(`ledger-${S.today()}.csv`, S.toCSV(rows, state.data));
  },
  'export-json': () => download(`ledger-backup-${S.today()}.json`,
    JSON.stringify(state.data, null, 2), 'application/json'),
  wipe: async () => {
    if (!confirm('Erase all ledger data stored on this device?')) return;
    await db.wipeLocal();
    await boot();
    toast('Local data erased');
  },
  'del-budget': async (el) => { await S.remove('budgets', el.dataset.id); await refresh(); trySync(); },
  'copy-budgets': async () => {
    const previous = S.monthStart(S.shiftMonth(state.month, -1));
    const source = state.data.budgets.filter(b => b.month === previous);
    for (const b of source) {
      await S.save('budgets', { household_id: state.householdId, category_id: b.category_id,
        month: S.monthStart(state.month), amount: b.amount });
    }
    await refresh(); trySync(); toast(`Copied ${source.length} budgets`);
  },
  'del-rule': async (el) => { await S.remove('rules', el.dataset.id); await refresh(); trySync(); },
  'post-due': async (el) => {
    const rule = state.data.rules.find(r => r.id === el.dataset.id);
    if (!rule) return;
    await S.save('transactions', S.normaliseTransaction(
      { ...rule.template, occurred_on: el.dataset.date, source: 'recurring' }, state.householdId));
    await S.save('rules', { ...rule, next_on: S.advance(el.dataset.date, rule.cadence) });
    await refresh(); trySync(); toast('Posted ' + rule.label);
  },
  'skip-due': async (el) => {
    const rule = state.data.rules.find(r => r.id === el.dataset.id);
    if (!rule) return;
    await S.save('rules', { ...rule, next_on: S.advance(el.dataset.date, rule.cadence) });
    await refresh(); trySync();
  },
  'del-account': async (el) => { await S.remove('accounts', el.dataset.id); await refresh(); trySync(); },
  'del-person': async (el) => { await S.remove('people', el.dataset.id); await refresh(); trySync(); },
  'del-category': async (el) => {
    const children = state.data.categories.filter(c => c.parent_id === el.dataset.id);
    if (children.length && !confirm(`This also removes ${children.length} sub-categories. Continue?`)) return;
    for (const child of children) await S.remove('categories', child.id);
    await S.remove('categories', el.dataset.id);
    await refresh(); trySync();
  },
  essential: async (el) => {
    const category = catById(el.dataset.id);
    await S.save('categories', { ...category, essential: el.checked });
    await refresh(); trySync();
  },
  'toggle-all': (el) => {
    document.querySelectorAll('#import-preview tbody input[type=checkbox]').forEach(box => { box.checked = el.checked; });
  },
  'cancel-import': () => { state.importDraft = null; render(); },
  'commit-import': async () => {
    const draft = state.importDraft;
    if (!draft) return;
    let added = 0;
    document.querySelectorAll('#import-preview tbody tr').forEach(() => {});
    for (let i = 0; i < draft.rows.length; i++) {
      const box = document.querySelector(`#import-preview tbody input[type=checkbox][data-row="${i}"]`);
      if (!box || !box.checked) continue;
      try {
        await S.save('transactions', S.normaliseTransaction(draft.rows[i], state.householdId));
        added++;
      } catch { /* a row with no account cannot be saved; leave it for the user */ }
    }
    state.importDraft = null;
    await refresh(); trySync();
    toast(`Added ${added} entries`);
  },
  'sync-now': async () => {
    const result = await trySync({ quiet: false });
    if (result.ok) toast(`Synced — ${result.pushed} up, ${result.pulled} down`);
    else if (result.reason !== 'error') toast('Not syncing: ' + result.reason, 'bad');
    paintCloudPanel();
  },
  signout: async () => { await cloud.signOut(); state.user = null; paintCloudPanel(); },
  'forget-firebase': async () => { await cloud.setConfig(null); paintCloudPanel(); },
  'retry-cloud': async () => { await trySync({ quiet: false }); await paintCloudPanel(); },
  'copy-code': (el) => {
    navigator.clipboard.writeText(el.dataset.code).then(() => toast('Invite code copied'));
  },
  menu: () => { const m = $('#menu'); m.hidden = !m.hidden; },
  theme: async () => {
    const current = (await db.meta.get('theme')) || 'system';
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    await db.meta.set('theme', next);
    applyTheme(next);
  },
};

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = ACTIONS[target.dataset.action];
  if (!action) return;
  if (target.tagName !== 'INPUT') event.preventDefault();
  try { await action(target); } catch (err) { toast(err.message || 'Something went wrong', 'bad'); }
});

document.addEventListener('change', async (event) => {
  const filter = event.target.closest('[data-filter]');
  if (filter) {
    state.filters[filter.dataset.filter] = filter.value;
    render();
    const restored = document.querySelector(`[data-filter="${filter.dataset.filter}"]`);
    if (restored && restored.type !== 'search') restored.focus();
    return;
  }
  const picker = event.target.closest('[data-action="pick-household"]');
  if (picker) {
    if (!(await confirmReplaceLocal(picker.value))) { render(); return; }
    await cloud.useHousehold(picker.value);
    state.householdId = picker.value;
    await trySync({ quiet: false });          // pull before seeding, as above
    await S.seedIfEmpty(state.householdId);
    await refresh();
    return;
  }
  const cell = event.target.closest('#import-preview [data-field]');
  if (cell && state.importDraft) {
    const row = state.importDraft.rows[Number(cell.dataset.row)];
    row[cell.dataset.field] = cell.dataset.field === 'category_id' ? (cell.value || null) : cell.value;
    if (cell.dataset.field === 'kind') render();
  }
});

// Search filter should not re-render on every keystroke and steal the caret.
document.addEventListener('input', (event) => {
  if (event.target.id !== 'f-text') return;
  clearTimeout(document._searchTimer);
  const value = event.target.value;
  document._searchTimer = setTimeout(() => {
    state.filters.text = value;
    render();
    const box = $('#f-text');
    if (box) { box.focus(); box.setSelectionRange(value.length, value.length); }
  }, 250);
});

// ---------------------------------------------------------------------- forms

const FORMS = {
  txn: async (form, submitter) => saveSheet(form, submitter && submitter.name === 'again'),

  budget: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    const amount = parseAmount(data.amount);
    if (!amount) throw new Error('Enter a budget amount.');
    const month = S.monthStart(state.month);
    const existing = state.data.budgets.find(b => b.category_id === data.category_id && b.month === month);
    await S.save('budgets', { ...(existing || {}), household_id: state.householdId,
      category_id: data.category_id, month, amount });
    await refresh(); trySync(); toast('Budget saved');
  },

  rule: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    const amount = parseAmount(data.amount);
    if (!amount) throw new Error('Enter an amount.');
    await S.save('rules', {
      household_id: state.householdId, label: data.label, cadence: data.cadence,
      next_on: data.next_on, ends_on: null,
      template: { kind: data.kind, amount, account_id: data.account_id,
                  category_id: data.category_id || null, payee: data.label },
    });
    form.reset();
    await refresh(); trySync(); toast('Rule added');
  },

  account: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    await S.save('accounts', {
      household_id: state.householdId, name: data.name, type: data.type,
      opening_balance: parseAmount(data.opening_balance) || 0, currency: state.currency,
      archived: false, sort: state.data.accounts.length,
    });
    form.reset();
    await refresh(); trySync();
  },

  person: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    await S.save('people', { household_id: state.householdId, name: data.name, color: null });
    form.reset();
    await refresh(); trySync();
  },

  category: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    const parent = data.parent_id ? catById(data.parent_id) : null;
    await S.save('categories', {
      household_id: state.householdId, name: data.name,
      flow: parent ? parent.flow : data.flow, parent_id: data.parent_id || null,
      essential: parent ? parent.essential : false, sort: 99,
    });
    form.reset();
    await refresh(); trySync();
  },

  sms: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    if (!data.blob.trim()) throw new Error('Paste some messages first.');
    const { drafts, skipped } = imp.parseMomoSms(data.blob, { accountId: data.account_id });
    const { kept, duplicates } = imp.dedupe(drafts, state.data.transactions);
    state.importDraft = { rows: kept, duplicates: duplicates.length, skipped };
    render();
    const preview = $('#import-preview');
    if (preview) preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!kept.length) toast('Nothing new found in that paste', 'bad');
  },

  csv: async (form) => {
    const data = new FormData(form);
    const file = data.get('file');
    if (!file || !file.size) throw new Error('Choose a CSV file.');
    const text = await file.text();
    const rows = imp.parseCSV(text, imp.sniffDelimiter(text));
    if (rows.length < 2) throw new Error('That file has no rows.');
    const drafts = imp.rowsToDrafts(rows, imp.guessMapping(rows[0]), {
      accountId: data.get('account_id'), dayFirst: data.get('dayfirst') === 'on',
    });
    const { kept, duplicates } = imp.dedupe(drafts, state.data.transactions);
    state.importDraft = { rows: kept, duplicates: duplicates.length, skipped: [] };
    render();
    const preview = $('#import-preview');
    if (preview) preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  firebase: async (form) => {
    const data = Object.fromEntries(new FormData(form));
    await cloud.setConfig(data.config);
    await paintCloudPanel();
    toast('Connected. Sign in next.');
  },

  signin: async (form, submitter) => {
    const data = Object.fromEntries(new FormData(form));
    const mode = (submitter && submitter.value) || 'in';
    if (mode === 'up') {
      await cloud.signUp(data.email, data.password);
      toast('Account created. Check your inbox if confirmation is on.');
    } else {
      await cloud.signIn(data.email, data.password);
      toast('Signed in');
    }
    await paintCloudPanel();
  },

  'new-household': async (form) => {
    const data = Object.fromEntries(new FormData(form));
    const household = await cloud.createHousehold(data.name, state.currency);
    // Whatever is already on this device becomes this household's opening
    // ledger, rather than being discarded.
    await cloud.useHousehold(household.id, { keepLocal: true });
    state.householdId = household.id;
    const moved = await S.reassignHousehold(household.id);
    await S.seedIfEmpty(household.id);
    await refresh({ rerender: false });
    await trySync({ quiet: false });
    await refresh();
    toast(`Created ${household.name} — invite code ${household.invite_code}` +
      (moved ? ` · brought ${moved} existing records with you` : ''));
  },

  'join-household': async (form) => {
    const data = Object.fromEntries(new FormData(form));
    if (!(await confirmReplaceLocal())) return;
    const household = await cloud.joinHousehold(data.code, state.user && state.user.email);
    await cloud.useHousehold(household.id);
    state.householdId = household.id;
    // Pull before seeding. Seeding first would recreate the default accounts
    // and categories locally, and the pull would then land the household's own
    // copies alongside them — one duplicate of every default.
    await trySync({ quiet: false });
    await S.seedIfEmpty(household.id);
    await refresh();
    toast('Joined ' + household.name);
  },
};

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const handler = FORMS[form.dataset.form];
  if (!handler) return;
  const submitter = event.submitter;
  try {
    await handler(form, submitter);
    const dialog = form.closest('dialog');
    if (dialog && !(submitter && submitter.name === 'again')) dialog.close();
  } catch (err) {
    toast(err.message || 'Could not save', 'bad');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'n' && !/input|textarea|select/i.test(event.target.tagName) && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    openSheet(null);
  }
});

// -------------------------------------------------------------------- startup

async function boot() {
  applyTheme((await db.meta.get('theme')) || 'system');
  const config = await cloud.getConfig();
  const joined = Boolean(config.householdId);
  state.householdId = config.householdId || (await db.meta.get('local_household')) || null;

  if (!state.householdId) {
    // No cloud yet: run against a local household id so rows are already
    // shaped for sync the day one is created.
    state.householdId = S.uid();
    await db.meta.set('local_household', state.householdId);
  }

  // A device already attached to a household seeds only after its first pull.
  // Seeding a fresh phone before it has synced would give the household a
  // second set of default accounts and categories.
  if (!joined) await S.seedIfEmpty(state.householdId);
  await refresh({ rerender: false });

  const hash = location.hash.replace('#', '');
  if (VIEWS[hash]) state.view = hash;
  render();

  if (await cloud.isConfigured()) {
    trySync()
      .then(async () => {
        await S.seedIfEmpty(state.householdId);   // no-op once the pull brought data
        await refresh();
        return cloud.subscribeRealtime(() => trySync());
      })
      .catch(() => {});
    cloud.onAuthChange(() => paintCloudPanel());
  } else {
    state.sync = { status: 'local', message: 'This device only' };
    paintSyncBadge();
  }
}

window.addEventListener('online', () => trySync());

// The chart viewBox is measured in real pixels, so a rotation or resize needs
// a repaint — but only of the charts, not the whole view.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === 'insights') paintInsightCharts();
    else if (state.view === 'home' && $('#viz-flow')) {
      renderFlowChart($('#viz-flow'),
        S.monthlyTrend(state.data.transactions, state.data.categories, 6, state.month), state.currency);
    }
  }, 180);
});
window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '');
  if (VIEWS[hash] && hash !== state.view) { state.view = hash; render(); }
});

$('#add-btn').addEventListener('click', () => openSheet(null));
document.querySelectorAll('.tab').forEach(tab =>
  tab.addEventListener('click', () => go(tab.dataset.view)));
document.querySelectorAll('[data-menu-view]').forEach(item =>
  item.addEventListener('click', () => go(item.dataset.menuView)));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

boot();
