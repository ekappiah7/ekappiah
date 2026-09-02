// End-to-end sync: two devices, one household, driven through the real app in
// a real browser against the Auth + Firestore emulators.
//
// The rules tests prove the rules; this proves the client actually honours
// them and that a change made on one phone reaches another. It caught two
// bugs the unit tests could not see: a joining device kept its own seeded
// accounts and categories (one duplicate of every default) and pushed them
// into the household it was joining.
//
// Needs, in three terminals or one script:
//   1. a static server at the repo root      python3 -m http.server 8777
//   2. the vendored SDK                      sh vendor/fetch-sdk.sh
//   3. this, from firebase/                  npm run test:e2e
//
// Chromium comes from Playwright; set CHROME_PATH to override.
import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://127.0.0.1:8777/index.html';
const CONFIG = {
  apiKey: 'demo-key', authDomain: 'localhost', projectId: 'family-ledger-rules-test',
  appId: '1:1:web:1',
  emulator: { host: '127.0.0.1', authPort: 9099, firestorePort: 8080 },
  sdk_base: (process.env.APP_URL || 'http://127.0.0.1:8777/index.html')
    .replace(/\/index\.html$/, '') + '/vendor/firebase',
};

// This sandbox reaches the internet only through an intercepting proxy, so the
// browser needs it too (curl gets it from the environment; Chromium does not).
// The cert override is for this harness only — nothing shipped relies on it.
// Everything is served from the local static server: the app, the emulators,
// and the Firebase SDK itself (via vendor/fetch-sdk.sh). No egress needed.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

async function device(label) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`[${label} pageerror]`, e.message.slice(0, 140)));
  // Not networkidle: the webfont is fetched from a third party and a slow or
  // blocked network leaves that request open forever. It never blocks render.
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tabbar');
  await page.waitForTimeout(400);
  await page.evaluate(async (cfg) => {
    const cloud = await import('./js/cloud.js');
    await cloud.setConfig(JSON.stringify(cfg));
  }, CONFIG);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tabbar');
  await page.waitForTimeout(900);
  return { label, page, ctx };
}

const api = (d, fn, ...args) => d.page.evaluate(async ({ fn, args }) => {
  const cloud = await import('./js/cloud.js');
  const S = await import('./js/store.js');
  const db = await import('./js/db.js');
  return await (new Function('cloud', 'S', 'db', 'args', `return (${fn})(cloud, S, db, ...args)`))(cloud, S, db, args);
}, { fn: fn.toString(), args });

const step = (n, msg) => console.log(`${n}. ${msg}`);

// ---- Device A: sign up, create household, add entries, sync -----------------
const a = await device('A');
step(1, 'A signs up: ' + await api(a, async (cloud) => {
  const user = await cloud.signUp('ernest@example.com', 'passw0rd123');
  return user.email;
}));

const household = await api(a, async (cloud, S, db) => {
  const h = await cloud.createHousehold('The AKs', 'GHS');
  await cloud.useHousehold(h.id, { keepLocal: true });
  await S.reassignHousehold(h.id);
  await S.seedIfEmpty(h.id);
  return { id: h.id, code: h.invite_code };
});
step(2, `A creates household — invite code ${household.code}`);

step(3, 'A adds entries: ' + await api(a, async (cloud, S, db) => {
  const hid = await db.meta.get('household_id');
  const acct = (await S.loadAll()).accounts[0];
  const cats = (await S.loadAll()).categories;
  const salary = cats.find(c => c.name === 'Salary');
  const rent = cats.find(c => c.name === 'Rent');
  await S.save('transactions', S.normaliseTransaction(
    { kind: 'income', amount: 420000, occurred_on: '2026-09-01', account_id: acct.id, category_id: salary.id, payee: 'KsTU' }, hid));
  await S.save('transactions', S.normaliseTransaction(
    { kind: 'expense', amount: 95000, occurred_on: '2026-09-02', account_id: acct.id, category_id: rent.id, payee: 'Rent' }, hid));
  return (await S.loadAll()).transactions.length + ' local';
}));

step(4, 'A syncs: ' + JSON.stringify(await api(a, async (cloud) => cloud.sync())));

// ---- Device B: separate browser context, joins with the code ---------------
const b = await device('B');
step(5, 'B signs up: ' + await api(b, async (cloud) => (await cloud.signUp('spouse@example.com', 'passw0rd123')).email));

step(6, 'B joins: ' + JSON.stringify(await api(b, async (cloud, S, db, code) => {
  const h = await cloud.joinHousehold(code, 'Spouse');
  await cloud.useHousehold(h.id);
  return { name: h.name, localAfterWipe: (await S.loadAll()).categories.length };
}, household.code)));

step(7, 'B syncs then seeds: ' + JSON.stringify(await api(b, async (cloud, S, db) => {
  const r = await cloud.sync();
  await S.seedIfEmpty(await db.meta.get('household_id'));
  return r;
})));

const bData = await api(b, async (cloud, S) => {
  const d = await S.loadAll();
  const { from, to } = S.monthRange('2026-09');
  const sum = S.summarise(d.transactions, from, to, d.categories);
  return { accounts: d.accounts.length, categories: d.categories.length,
           txns: d.transactions.length, inflow: sum.inflow, outflow: sum.outflow, net: sum.net };
});
step(8, 'B sees: ' + JSON.stringify(bData));

// ---- B edits, A pulls -------------------------------------------------------
step(9, 'B adds an entry and syncs: ' + JSON.stringify(await api(b, async (cloud, S, db) => {
  const hid = await db.meta.get('household_id');
  const d = await S.loadAll();
  await S.save('transactions', S.normaliseTransaction(
    { kind: 'expense', amount: 62050, occurred_on: '2026-09-05',
      account_id: d.accounts[0].id, category_id: d.categories.find(c => c.name === 'Groceries').id,
      payee: 'Melcom' }, hid));
  return cloud.sync();
})));

step(10, 'A syncs and sees: ' + JSON.stringify(await api(a, async (cloud, S) => {
  const r = await cloud.sync();
  const d = await S.loadAll();
  return { sync: r, txns: d.transactions.length, payees: d.transactions.map(t => t.payee).sort() };
})));

// ---- Tombstone propagation --------------------------------------------------
step(11, 'A deletes "Rent" and syncs: ' + JSON.stringify(await api(a, async (cloud, S) => {
  const d = await S.loadAll();
  const rent = d.transactions.find(t => t.payee === 'Rent');
  await S.remove('transactions', rent.id);
  return cloud.sync();
})));

step(12, 'B syncs — deletion propagates: ' + JSON.stringify(await api(b, async (cloud, S) => {
  const r = await cloud.sync();
  const d = await S.loadAll();
  return { sync: r, txns: d.transactions.length, payees: d.transactions.map(t => t.payee).sort() };
})));

// ---- Isolation: a third user must not see this household -------------------
const c = await device('C');
const stranger = JSON.parse(await api(c, async (cloud, S, db, hid) => {
  const user = await cloud.signUp('stranger@example.com', 'passw0rd123');
  const fb = await cloud.getClient();
  const { doc, getDoc, getDocs, collection, query, orderBy, limit } = fb.f;
  const out = { uid: user.uid, signedInAs: fb.auth.currentUser && fb.auth.currentUser.email };
  const m = await getDoc(doc(fb.fs, 'households', hid, 'members', user.uid)).catch(e => ({ err: e.code }));
  out.isMember = m && m.exists ? m.exists() : m.err;
  try {
    const snap = await getDocs(query(collection(fb.fs, 'households', hid, 'transactions'),
      orderBy('updated_at', 'asc'), limit(50)));
    out.rawList = snap.size;
  } catch (e) { out.rawList = e.code || e.message; }
  await cloud.useHousehold(hid);
  out.sync = await cloud.sync();
  out.localTxnsAfter = (await S.loadAll()).transactions.length;
  return JSON.stringify(out);
}, household.id));
step(13, 'C (non-member) tries: ' + JSON.stringify(stranger));

// Assertions, so a regression fails the run rather than printing quietly.
const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`}`);
  if (!ok) process.exitCode = 1;
};
expect('B inherits exactly one set of defaults', [bData.accounts, bData.categories], [4, 48]);
expect('B sees A\'s two entries', bData.txns, 2);
expect('B computes the same net', bData.net, 325000);
expect('a non-member is refused', stranger.sync.ok, false);
expect('a non-member leaks nothing', stranger.localTxnsAfter, 0);

await browser.close();
