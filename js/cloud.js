// Firebase: auth, household membership, and the sync engine.
//
// IndexedDB stays the source of truth. Firestore ships its own offline cache,
// but the app is built so it works with no Firebase project configured at all,
// and every analytic in store.js reads plain arrays synchronously — so
// Firestore is a replica this module pushes to and pulls from, not the store.
//
// The app never blocks on this file. With no config, no network, or no
// session, everything still works locally and changes queue as dirty rows
// until a sync succeeds.

import * as db from './db.js';

const VERSION = '10.14.1';
const DEFAULT_CDN = `https://www.gstatic.com/firebasejs/${VERSION}`;

// Where to fetch the Firebase SDK from. Defaults to Google's CDN; set
// `sdk_base` in the config to serve the three modules yourself instead, which
// is the answer when a network blocks gstatic.com (see the README).
let cdnBase = DEFAULT_CDN;

// local store -> Firestore subcollection under households/{id}
export const TABLES = {
  accounts: 'accounts',
  categories: 'categories',
  people: 'people',
  transactions: 'transactions',
  budgets: 'budgets',
  rules: 'rules',
};

let sdk = null;      // the three Firebase modules, loaded once
let app = null;
let appKey = '';
let unreachable = null;

/** Why the SDK could not be reached, or null when it is fine. */
export const sdkError = () => unreachable;

const SDK_TIMEOUT = 15000;

async function loadSdk(base = cdnBase) {
  if (sdk) return sdk;
  // A captive portal or a filtering proxy can leave the request hanging rather
  // than refusing it, and an await that never settles leaves the settings
  // screen stuck on "Connecting…" forever. Always land somewhere.
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timed out fetching the Firebase SDK.')), SDK_TIMEOUT));
  const [core, auth, firestore] = await Promise.race([
    Promise.all([
      import(/* @vite-ignore */ `${base}/firebase-app.js`),
      import(/* @vite-ignore */ `${base}/firebase-auth.js`),
      import(/* @vite-ignore */ `${base}/firebase-firestore.js`),
    ]),
    timeout,
  ]);
  sdk = { core, auth, firestore };
  return sdk;
}

// ------------------------------------------------------------------- config
// A Firebase web config is a JS object people copy out of the console. Accept
// it however it arrives — the whole `const firebaseConfig = {...}` snippet,
// bare JSON, or single-quoted keys — rather than making someone hand-edit it
// into strict JSON first.

const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId'];

/** Quote bare keys, normalise quotes, drop comments and trailing commas. */
function toStrictJson(body) {
  return body
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => JSON.stringify(inner))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')  // bare keys
    .replace(/,(\s*[}\]])/g, '$1');                          // trailing commas
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');      // line comments, sparing https://
}

/**
 * Pull every top-level `{ ... }` out of a blob, skipping braces inside string
 * literals. The console snippet opens with `import { initializeApp } from …`,
 * so "first brace to last brace" grabs the import statement and everything
 * after it — which is what the earlier version did, and why pasting the real
 * snippet failed.
 */
function objectLiterals(text) {
  const blocks = [];
  let depth = 0, start = -1, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start > -1) { blocks.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return blocks;
}

/**
 * Accept a Firebase web config however it arrives: bare JSON, the
 * `const firebaseConfig = { … };` line on its own, or the whole snippet the
 * console shows including the import and the initializeApp call.
 */
export function parseFirebaseConfig(input) {
  if (!input) throw new Error('Paste your Firebase config.');
  if (typeof input === 'object') return input;

  const text = stripComments(String(input));
  // The config is the block that has an apiKey in it — not the import braces.
  const candidates = objectLiterals(text).filter(b => /["']?apiKey["']?\s*:/.test(b));
  if (!candidates.length) {
    throw new Error('No Firebase config found in that paste — it needs the { apiKey: … } block.');
  }

  let parsed = null;
  for (const block of candidates) {
    for (const form of [block, toStrictJson(block)]) {
      try { parsed = JSON.parse(form); break; } catch { /* try the next form */ }
    }
    if (parsed) break;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not read that config. Copy the whole { ... } block from the Firebase console.');
  }
  const missing = REQUIRED.filter(key => !parsed[key]);
  if (missing.length) throw new Error('Config is missing: ' + missing.join(', '));
  return parsed;
}

export async function getConfig() {
  const [config, householdId] = await Promise.all([
    db.meta.get('firebase_config'), db.meta.get('household_id'),
  ]);
  return { config: config || null, householdId: householdId || null };
}

export async function setConfig(input) {
  if (!input) {
    await db.meta.del('firebase_config');
  } else {
    await db.meta.set('firebase_config', parseFirebaseConfig(input));
  }
  app = null;
  appKey = '';
}

export const isConfigured = async () => Boolean((await getConfig()).config);

/**
 * Returns the initialised Firebase handles, or null. Null means one of two
 * things and they are not the same: no project is configured, or one is but
 * the SDK could not be fetched. This never throws — a blocked CDN or a dead
 * connection must not take the local app down with it, so callers check
 * sdkError() to tell the two apart.
 */
async function getApp() {
  const { config } = await getConfig();
  if (!config) { unreachable = null; return null; }
  const key = config.projectId + '|' + config.appId;
  if (app && appKey === key) return app;
  try {
    cdnBase = config.sdk_base ? String(config.sdk_base).replace(/\/+$/, '') : DEFAULT_CDN;
    const { core, auth, firestore } = await loadSdk(cdnBase);
    const instance = core.getApps().length ? core.getApp() : core.initializeApp(config);
    app = {
      instance,
      auth: auth.getAuth(instance),
      fs: firestore.getFirestore(instance),
      a: auth,
      f: firestore,
    };
    // Opt-in local emulators, for developing against `firebase emulators:start`
    // without touching the real project. Set an `emulator` key in the config.
    if (config.emulator) {
      const host = config.emulator.host || '127.0.0.1';
      auth.connectAuthEmulator(app.auth, `http://${host}:${config.emulator.authPort || 9099}`,
        { disableWarnings: true });
      firestore.connectFirestoreEmulator(app.fs, host, config.emulator.firestorePort || 8080);
    }
    await app.a.setPersistence(app.auth, app.a.browserLocalPersistence).catch(() => {});
    appKey = key;
    unreachable = null;
    return app;
  } catch (err) {
    app = null;
    appKey = '';
    unreachable = !navigator.onLine
      ? 'Offline — Firebase will connect again when you are back online.'
      : cdnBase === DEFAULT_CDN
        ? 'Could not load the Firebase SDK. Something on this network is blocking gstatic.com.'
        : `Could not load the Firebase SDK from ${cdnBase}.`;
    return null;
  }
}

/** Kept for symmetry with the rest of the app: null means "running standalone". */
export const getClient = getApp;

// -------------------------------------------------------------------- auth

export async function currentUser() {
  const fb = await getApp();
  if (!fb) return null;   // not configured, or the SDK is unreachable
  if (fb.auth.currentUser) return fb.auth.currentUser;
  // On a cold start the session is restored asynchronously; wait for the first
  // resolution rather than reporting a signed-in user as signed out.
  return new Promise(resolve => {
    const stop = fb.a.onAuthStateChanged(fb.auth, user => { stop(); resolve(user); });
  });
}

const friendlyAuthError = (err) => {
  const map = {
    'auth/invalid-credential': 'That email and password did not match.',
    'auth/wrong-password': 'That email and password did not match.',
    'auth/user-not-found': 'No account with that email — create one instead.',
    'auth/email-already-in-use': 'That email already has an account — sign in instead.',
    'auth/weak-password': 'Use a password of at least 8 characters.',
    'auth/operation-not-allowed': 'Enable Email/Password sign-in in the Firebase console first.',
    'auth/network-request-failed': 'No connection to Firebase.',
  };
  return new Error(map[err && err.code] || (err && err.message) || String(err));
};

export async function signUp(email, password) {
  const fb = await getApp();
  if (!fb) throw new Error(unreachable || 'Add your Firebase config first.');
  try {
    const { user } = await fb.a.createUserWithEmailAndPassword(fb.auth, email, password);
    return user;
  } catch (err) { throw friendlyAuthError(err); }
}

export async function signIn(email, password) {
  const fb = await getApp();
  if (!fb) throw new Error(unreachable || 'Add your Firebase config first.');
  try {
    const { user } = await fb.a.signInWithEmailAndPassword(fb.auth, email, password);
    return user;
  } catch (err) { throw friendlyAuthError(err); }
}

export async function signOut() {
  const fb = await getApp();
  if (fb) await fb.a.signOut(fb.auth);
}

export function onAuthChange(handler) {
  getApp().then(fb => { if (fb) fb.a.onAuthStateChanged(fb.auth, handler); });
}

// --------------------------------------------------------------- households
//
// Firestore has no stored procedures, so the three household operations run as
// ordinary client writes and the security rules decide whether they are
// allowed. Deliberately no Cloud Functions: they need the Blaze plan, and a
// family ledger should not require a billing account.
//
//   households/{hid}                  the household itself
//   households/{hid}/members/{uid}    who may read and write it
//   households/{hid}/{table}/{id}     the ledger
//   inviteCodes/{CODE}                code -> household, so a code can be redeemed
//   users/{uid}/households/{hid}      each person's own list, to avoid a collection query

const randomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(n => alphabet[n % alphabet.length]).join('');
};

export async function listHouseholds() {
  const fb = await getApp();
  const user = await currentUser();
  if (!fb || !user) return [];
  const { collection, getDocs } = fb.f;
  const snapshot = await getDocs(collection(fb.fs, 'users', user.uid, 'households'));
  return snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() }));
}

export async function createHousehold(name, currency = 'GHS') {
  const fb = await getApp();
  const user = await currentUser();
  if (!fb) throw new Error(unreachable || 'Add your Firebase config first.');
  if (!user) throw new Error('Sign in first.');
  const { doc, setDoc, serverTimestamp } = fb.f;

  const householdId = crypto.randomUUID();
  const inviteCode = randomCode();
  const household = { name, currency, invite_code: inviteCode, created_by: user.uid };

  // Ordered, not batched: the member rule checks the household document, and a
  // batch would evaluate every write against the state before the batch.
  await setDoc(doc(fb.fs, 'households', householdId), { ...household, created_at: serverTimestamp() });
  await setDoc(doc(fb.fs, 'households', householdId, 'members', user.uid), {
    role: 'owner', display_name: user.email || 'Owner', joined_at: serverTimestamp(),
  });
  await setDoc(doc(fb.fs, 'inviteCodes', inviteCode), { household_id: householdId, created_by: user.uid });
  await setDoc(doc(fb.fs, 'users', user.uid, 'households', householdId),
    { name, currency, invite_code: inviteCode, role: 'owner' });

  return { id: householdId, ...household };
}

export async function joinHousehold(code, displayName) {
  const fb = await getApp();
  const user = await currentUser();
  if (!fb) throw new Error(unreachable || 'Add your Firebase config first.');
  if (!user) throw new Error('Sign in first.');
  const { doc, getDoc, setDoc, serverTimestamp } = fb.f;

  const cleanCode = String(code || '').trim().toUpperCase();
  const codeDoc = await getDoc(doc(fb.fs, 'inviteCodes', cleanCode));
  if (!codeDoc.exists()) throw new Error('No household with that invite code.');
  const householdId = codeDoc.data().household_id;

  // The code on the member document is the proof of invitation the rules check.
  await setDoc(doc(fb.fs, 'households', householdId, 'members', user.uid), {
    role: 'member', display_name: displayName || user.email || 'Member',
    invite_code: cleanCode, joined_at: serverTimestamp(),
  });

  const household = await getDoc(doc(fb.fs, 'households', householdId));
  const data = household.exists() ? household.data() : { name: 'Household', currency: 'GHS' };
  await setDoc(doc(fb.fs, 'users', user.uid, 'households', householdId), {
    name: data.name, currency: data.currency || 'GHS', invite_code: cleanCode, role: 'member',
  });
  return { id: householdId, ...data };
}

/**
 * The household this device's local rows currently belong to. Before any
 * cloud project exists the app still runs against a household id — a local
 * one — so both keys have to be consulted. Reading only `household_id` was a
 * bug: joining a household then left the previous rows in place, which both
 * duplicated the seeded accounts and categories and pushed this device's
 * throwaway defaults into the household being joined.
 */
export async function currentLocalHousehold() {
  return (await db.meta.get('household_id')) || (await db.meta.get('local_household')) || null;
}

/**
 * Point this device at a household.
 *
 * `keepLocal` decides what happens to rows already here, and the two callers
 * want opposite things. Creating a household from a device you have been
 * tracking on solo should carry that history in (keepLocal: true, with
 * store.reassignHousehold doing the rewrite). Joining somebody else's existing
 * ledger should not — merging two independently seeded category trees leaves a
 * duplicate of every default — so the local rows are cleared.
 */
export async function useHousehold(householdId, { keepLocal = false } = {}) {
  const previous = await currentLocalHousehold();
  if (!keepLocal && previous && previous !== householdId) await db.wipeLocal();
  await db.meta.set('household_id', householdId);
  await db.meta.del('local_household');
}

// -------------------------------------------------------------------- sync
//
// Push first, then pull. Push sends every locally-changed row and lets the
// server stamp updated_at; pull asks for everything stamped at or after our
// cursor. Whichever write reaches the server last wins, which for a household
// of a few phones is the behaviour people actually expect — and because
// deletes are tombstones, a row deleted on one phone disappears on the others
// instead of coming back to life.

const PAGE = 400;                                    // writeBatch caps at 500 ops
const CURSOR_ZERO = '1970-01-01T00:00:00.000Z';

const strip = (row) => {
  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('_') || key === 'updated_at') continue;
    clean[key] = value === undefined ? null : value;
  }
  return clean;
};

/** Firestore Timestamp -> ISO string, so local rows stay comparable as text. */
const toIso = (value) => {
  if (!value) return CURSOR_ZERO;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return new Date(value).toISOString();
};

export async function push(fb, householdId) {
  const { doc, writeBatch, serverTimestamp } = fb.f;
  let pushed = 0;
  for (const [store, table] of Object.entries(TABLES)) {
    const dirty = await db.dirtyRows(store);
    if (!dirty.length) continue;
    for (let i = 0; i < dirty.length; i += PAGE) {
      const slice = dirty.slice(i, i + PAGE);
      const batch = writeBatch(fb.fs);
      for (const row of slice) {
        batch.set(doc(fb.fs, 'households', householdId, table, row.id), {
          ...strip({ ...row, household_id: row.household_id || householdId }),
          updated_at: serverTimestamp(),
        });
      }
      await batch.commit();
      // Clear the flag locally; the pull that follows replaces updated_at with
      // the server's value.
      await db.putMany(store, slice.map(row => ({ ...row, _dirty: 0 })));
      pushed += slice.length;
    }
  }
  return pushed;
}

export async function pull(fb, householdId) {
  const { collection, query, where, orderBy, limit, getDocs, Timestamp } = fb.f;
  const cursor = (await db.meta.get('sync_cursors')) || {};
  let pulled = 0;

  for (const [store, table] of Object.entries(TABLES)) {
    let since = cursor[store] || CURSOR_ZERO;
    for (;;) {
      const snapshot = await getDocs(query(
        collection(fb.fs, 'households', householdId, table),
        where('updated_at', '>=', Timestamp.fromDate(new Date(since))),
        orderBy('updated_at', 'asc'),
        limit(PAGE),
      ));
      if (snapshot.empty) break;

      const rows = snapshot.docs.map(entry => {
        const data = entry.data();
        return { ...data, id: entry.id, updated_at: toIso(data.updated_at) };
      });

      // Locally dirty rows are edits that have not reached the server yet —
      // leave them alone, the next push carries them.
      const keep = [];
      for (const row of rows) {
        const local = await db.get(store, row.id);
        if (local && local._dirty) continue;
        keep.push({ ...row, _dirty: 0 });
      }
      if (keep.length) await db.putMany(store, keep);
      pulled += keep.length;

      const last = rows[rows.length - 1].updated_at;
      if (rows.length < PAGE || last === since) { since = last; break; }
      since = last;
    }
    cursor[store] = since;
  }
  await db.meta.set('sync_cursors', cursor);
  return pulled;
}

const friendlySyncError = (err) => {
  const message = (err && err.message) || String(err);
  if (/permission|insufficient|evaluation error|false for/i.test(message)) {
    return 'Firestore refused the write. Check the security rules are deployed and you have joined this household.';
  }
  if (/requires an index/i.test(message)) return 'Firestore needs an index — the console error links straight to it.';
  return message;
};

/** Returns {ok, pushed, pulled, reason} — never throws at the caller. */
export async function sync() {
  const fb = await getApp();
  if (!fb) return unreachable
    ? { ok: false, reason: 'unreachable', message: unreachable }
    : { ok: false, reason: 'not-configured' };
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  const user = await currentUser();
  if (!user) return { ok: false, reason: 'signed-out' };
  const householdId = await db.meta.get('household_id');
  if (!householdId) return { ok: false, reason: 'no-household' };
  try {
    const pushed = await push(fb, householdId);
    const pulled = await pull(fb, householdId);
    await db.meta.set('last_sync', new Date().toISOString());
    return { ok: true, pushed, pulled };
  } catch (err) {
    return { ok: false, reason: 'error', message: friendlySyncError(err) };
  }
}

/**
 * Live updates from other devices, so a shared phone is not a refresh button.
 * Each listener watches only the newest document in its collection — enough to
 * know something changed, without paying to stream the whole ledger.
 */
export async function subscribeRealtime(onChange) {
  const fb = await getApp();
  const householdId = await db.meta.get('household_id');
  if (!fb || !householdId) return null;
  const { collection, query, orderBy, limit, onSnapshot } = fb.f;

  const stops = Object.values(TABLES).map(table => onSnapshot(
    query(collection(fb.fs, 'households', householdId, table), orderBy('updated_at', 'desc'), limit(1)),
    snapshot => { if (!snapshot.metadata.hasPendingWrites) onChange(); },
    () => {},
  ));
  return { unsubscribe: () => stops.forEach(stop => stop()) };
}
