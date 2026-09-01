// Hand-rolled inline SVG. No chart library — three chart forms is not worth a
// dependency, and inline SVG inherits the page's theme tokens for free.
//
// Colour roles come from CSS custom properties (--series-in / --series-out /
// --series-1) so light and dark are each a selected palette rather than an
// automatic flip. Income is blue, spending is red, everywhere, always: colour
// follows the entity, never its rank.

import { formatMoney, formatPercent } from './money.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Bar path with only the two data-end corners rounded, anchored to the baseline. */
function barPath(x, y, w, h, r, orient = 'up') {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0.5) return `M${x} ${y + h}h${w}`;
  if (orient === 'up') {
    return `M${x} ${y + h}V${y + radius}a${radius} ${radius} 0 0 1 ${radius} ${-radius}` +
           `h${w - 2 * radius}a${radius} ${radius} 0 0 1 ${radius} ${radius}V${y + h}Z`;
  }
  // horizontal, growing right
  const rr = Math.max(0, Math.min(r, h / 2, w));
  return `M${x} ${y}h${w - rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${h - 2 * rr}` +
         `a${rr} ${rr} 0 0 1 ${-rr} ${rr}H${x}Z`;
}

function niceCeiling(value) {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function tooltipFor(container) {
  let tip = container.querySelector('.viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;
    container.appendChild(tip);
  }
  return tip;
}

function attachTip(container, target, html) {
  const tip = tooltipFor(container);
  const show = (event) => {
    tip.innerHTML = html;
    tip.hidden = false;
    const box = container.getBoundingClientRect();
    const x = (event.touches ? event.touches[0].clientX : event.clientX) - box.left;
    const y = (event.touches ? event.touches[0].clientY : event.clientY) - box.top;
    tip.style.left = Math.max(4, Math.min(box.width - tip.offsetWidth - 4, x - tip.offsetWidth / 2)) + 'px';
    tip.style.top = Math.max(4, y - tip.offsetHeight - 12) + 'px';
  };
  target.addEventListener('pointerenter', show);
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerleave', () => { tip.hidden = true; });
}

function emptyState(container, message) {
  container.innerHTML = `<p class="viz-empty">${message}</p>`;
}

/**
 * Match the viewBox to the container's real pixel width. A fixed viewBox
 * scaled down to a phone shrinks the axis labels with it — 10px in a 640-unit
 * box lands at about 5px on a 360px screen, which is not a label, it is a
 * smudge.
 */
const plotWidth = (container, min = 300) =>
  Math.max(min, Math.round(container.clientWidth || container.parentElement?.clientWidth || 340));

/**
 * Money in vs money out, one pair of bars per month. Two series, so: a legend
 * is always present, the pair sits in a fixed order inside each month, and a
 * 2px surface gap keeps the fills from touching.
 */
export function renderFlowChart(container, series, currency = 'GHS') {
  container.innerHTML = '';
  if (!series.length || series.every(m => !m.inflow && !m.outflow)) {
    return emptyState(container, 'No income or spending recorded yet.');
  }

  const W = plotWidth(container), H = 240, padL = 54, padR = 10, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceCeiling(Math.max(...series.flatMap(m => [m.inflow, m.outflow])) / 100) * 100;
  const y = (v) => padT + plotH - (v / max) * plotH;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg', role: 'img',
    'aria-label': 'Money in versus money out by month',
  });

  for (let i = 0; i <= 4; i++) {
    const value = (max / 4) * i;
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(value), y2: y(value), class: 'viz-grid' }));
    svg.appendChild(el('text', { x: padL - 8, y: y(value) + 4, class: 'viz-axis viz-axis-y' },
      formatMoney(value, currency, { compact: true })));
  }

  const slot = plotW / series.length;
  const barW = Math.min(22, (slot - 10) / 2);
  series.forEach((month, i) => {
    const centre = padL + slot * i + slot / 2;
    const pairs = [
      { key: 'inflow', label: 'In', value: month.inflow, cls: 'viz-bar-in', x: centre - barW - 1 },
      { key: 'outflow', label: 'Out', value: month.outflow, cls: 'viz-bar-out', x: centre + 1 },
    ];
    for (const bar of pairs) {
      const h = Math.max(0, (bar.value / max) * plotH);
      const path = el('path', { d: barPath(bar.x, y(bar.value), barW, h, 4), class: `viz-bar ${bar.cls}` });
      svg.appendChild(path);
      attachTip(container, path,
        `<strong>${month.label}</strong><br>${bar.label}: ${formatMoney(bar.value, currency)}`);
    }
    svg.appendChild(el('text', { x: centre, y: H - 12, class: 'viz-axis viz-axis-x' }, month.label));
    // Direct-label the net result rather than every bar — a number on every
    // mark is noise, but the one number people came for should not need hover.
    const net = month.inflow - month.outflow;
    if (month.inflow || month.outflow) {
      svg.appendChild(el('text', {
        x: centre, y: Math.min(y(Math.max(month.inflow, month.outflow)) - 6, padT + plotH - 4),
        class: 'viz-net ' + (net >= 0 ? 'is-positive' : 'is-negative'),
      }, formatMoney(net, currency, { compact: true, signed: true })));
    }
  });

  svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH, class: 'viz-baseline' }));
  container.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'viz-legend';
  legend.innerHTML = `
    <span><i class="swatch swatch-in"></i>Money in</span>
    <span><i class="swatch swatch-out"></i>Money out</span>`;
  container.appendChild(legend);
}

/**
 * Where the money went. One measure across categories, so identity lives on
 * the axis and every bar takes the same hue — a rainbow here would encode
 * nothing.
 */
export function renderCategoryBars(container, rows, currency = 'GHS', { limit = 8 } = {}) {
  container.innerHTML = '';
  if (!rows.length) return emptyState(container, 'Nothing in this period yet.');

  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  if (rest.length) shown.push({ id: 'other', name: `Other (${rest.length})`, total: rest.reduce((s, r) => s + r.total, 0) });

  const max = Math.max(...shown.map(r => r.total)) || 1;
  const total = rows.reduce((s, r) => s + r.total, 0);
  const list = document.createElement('div');
  list.className = 'viz-rows';
  for (const row of shown) {
    const item = document.createElement('div');
    item.className = 'viz-row';
    item.innerHTML = `
      <span class="viz-row-name" title="${row.name}">${row.name}</span>
      <span class="viz-row-track"><span class="viz-row-fill" style="width:${(row.total / max) * 100}%"></span></span>
      <span class="viz-row-value">${formatMoney(row.total, currency)}</span>
      <span class="viz-row-share">${formatPercent(total ? row.total / total : 0)}</span>`;
    list.appendChild(item);
  }
  container.appendChild(list);
}

/**
 * Savings rate over time — the ratio that only exists because inflows are in
 * the ledger. One series, so no legend box; the title names it.
 */
export function renderRateTrend(container, series) {
  container.innerHTML = '';
  const points = series.filter(m => m.savingsRate !== null);
  if (points.length < 2) return emptyState(container, 'Two months of income needed to show a trend.');

  const W = plotWidth(container), H = 170, padL = 48, padR = 14, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const values = points.map(p => p.savingsRate);
  const lo = Math.min(0, Math.floor(Math.min(...values) * 10) / 10);
  const hi = Math.max(0.1, Math.ceil(Math.max(...values) * 10) / 10);
  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg', role: 'img',
    'aria-label': 'Savings rate by month',
  });

  for (const value of [lo, (lo + hi) / 2, hi]) {
    svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(value), y2: y(value), class: 'viz-grid' }));
    svg.appendChild(el('text', { x: padL - 8, y: y(value) + 4, class: 'viz-axis viz-axis-y' }, formatPercent(value)));
  }
  if (lo < 0) svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), class: 'viz-zero' }));

  svg.appendChild(el('path', {
    d: points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.savingsRate)}`).join(' '),
    class: 'viz-line',
  }));

  points.forEach((p, i) => {
    const dot = el('circle', { cx: x(i), cy: y(p.savingsRate), r: 5, class: 'viz-dot' });
    svg.appendChild(dot);
    attachTip(container, dot, `<strong>${p.label}</strong><br>Saved ${formatPercent(p.savingsRate, 1)} of income`);
    svg.appendChild(el('text', { x: x(i), y: H - 8, class: 'viz-axis viz-axis-x' }, p.label));
  });

  const last = points[points.length - 1];
  svg.appendChild(el('text', {
    x: x(points.length - 1), y: y(last.savingsRate) - 12, class: 'viz-point-label',
  }, formatPercent(last.savingsRate)));

  container.appendChild(svg);
}

/** A bar is not always the answer: one number, big, when that is the message. */
export function renderStat(value, label, tone = '') {
  return `<div class="stat ${tone}"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}
