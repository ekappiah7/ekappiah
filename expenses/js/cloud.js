// Supabase: auth, household membership, and the sync engine.
//
// The app never blocks on this file. If there is no config, no network, or no
// session, everything still works against IndexedDB and the changes queue up
// as dirty rows until a sync succeeds.

import * as db from './db.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// local store -> remote table
export const TABLES = {
  accounts: 'accounts',
  categories: 'categories',
  people: 'people',
  transactions: 'transactions',
  budgets: 'budgets',
  rules: 'recurring_rules',
};

let client = null;
let clientKey = '';

export async function getConfig() {
  const [url, anonKey, householdId] = await Promise.all([
    db.meta.get('supabase_url'), db.meta.get('supabase_anon_key'), db.meta.get('household_id'),
  ]);
  return { url: url || '', anonKey: anonKey || '', householdId: householdId || null };
}

export async function setConfig({ url, anonKey }) {
  await db.meta.set('supabase_url', (url || '').trim().replace(/\/+$/, ''));
  await db.meta.set('supabase_anon_key', (anonKey || '').trim());
  client = null;
  clientKey = '';
}

export const isConfigured = async () => {
  const { url, anonKey } = await getConfig();
  return Boolean(url && anonKey);
};

/** Returns the Supabase client, or null when the app is running standalone. */
export async function getClient() {
  const { url, anonKey } = await getConfig();
  if (!url || !anonKey) return null;
  const key = url + '|' + anonKey;
  if (client && clientKey === key) return client;
  const { createClient } = await import(/* @vite-ignore */ SDK);
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'family-ledger-auth' },
  });
  clientKey = key;
  return client;
}

// -------------------------------------------------------------------- auth

export async function currentUser() {
  const sb = await getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data ? data.user : null;
}

export async function signUp(email, password) {
  const sb = await getClient();
  if (!sb) throw new Error('Add your Supabase URL and anon key first.');
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const sb = await getClient();
  if (!sb) throw new Error('Add your Supabase URL and anon key first.');
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const sb = await getClient();
  if (sb) await sb.auth.signOut();
}

export function onAuthChange(handler) {
  getClient().then(sb => { if (sb) sb.auth.onAuthStateChange((_e, session) => handler(session)); });
}

// --------------------------------------------------------------- households

export async function listHouseholds() {
  const sb = await getClient();
  if (!sb) return [];
  const { data, error } = await sb.rpc('my_households');
  if (error) throw error;
  return data || [];
}

export async function createHousehold(name, currency = 'GHS') {
  const sb = await getClient();
  const { data, error } = await sb.rpc('create_household', { p_name: name, p_currency: currency });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function joinHousehold(code, displayName) {
  const sb = await getClient();
  const { data, error } = await sb.rpc('join_household', { p_code: code, p_display_name: displayName || null });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function useHousehold(householdId) {
  const previous = await db.meta.get('household_id');
  if (previous && previous !== householdId) await db.wipeLocal();
  await db.meta.set('household_id', householdId);
}

// -------------------------------------------------------------------- sync
//
// Push first, then pull. Push sends every locally-changed row and lets the
// server stamp updated_at; pull asks for everything stamped at or after our
// cursor. Whichever write reaches the server last wins, which for a household
// of a few phones is the behaviour people actually expect — and because
// deletes are tombstones, a row deleted on one phone disappears on the others
// instead of coming back to life.

const PAGE = 500;
const strip = (row) => {
  const clean = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || k === 'updated_at') continue;
    clean[k] = v;
  }
  return clean;
};

async function cursors() { return (await db.meta.get('sync_cursors')) || {}; }

export async function push(sb, householdId) {
  let pushed = 0;
  for (const [store, table] of Object.entries(TABLES)) {
    const dirty = await db.dirtyRows(store);
    if (!dirty.length) continue;
    for (let i = 0; i < dirty.length; i += PAGE) {
      const batch = dirty.slice(i, i + PAGE)
        .map(row => strip({ ...row, household_id: row.household_id || householdId }));
      const { data, error } = await sb.from(table).upsert(batch, { onConflict: 'id' }).select();
      if (error) throw new Error(`${table}: ${error.message}`);
      // Re-store with the server's timestamp so the row stops looking dirty
      // and the next pull does not think it is stale.
      await db.putMany(store, (data || []).map(r => ({ ...r, _dirty: 0 })));
      pushed += (data || []).length;
    }
  }
  return pushed;
}

export async function pull(sb, householdId) {
  const cursor = await cursors();
  let pulled = 0;
  for (const [store, table] of Object.entries(TABLES)) {
    let since = cursor[store] || '1970-01-01T00:00:00Z';
    for (;;) {
      const { data, error } = await sb.from(table)
        .select('*')
        .eq('household_id', householdId)
        .gte('updated_at', since)
        .order('updated_at', { ascending: true })
        .limit(PAGE);
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = data || [];
      if (!rows.length) break;
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

/** Returns {ok, pushed, pulled, reason} — never throws at the caller. */
export async function sync() {
  const sb = await getClient();
  if (!sb) return { ok: false, reason: 'not-configured' };
  if (!navigator.onLine) return { ok: false, reason: 'offline' };
  const user = await currentUser();
  if (!user) return { ok: false, reason: 'signed-out' };
  const householdId = await db.meta.get('household_id');
  if (!householdId) return { ok: false, reason: 'no-household' };
  try {
    const pushed = await push(sb, householdId);
    const pulled = await pull(sb, householdId);
    await db.meta.set('last_sync', new Date().toISOString());
    return { ok: true, pushed, pulled };
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message || String(err) };
  }
}

/** Live updates from other devices, so a shared phone is not a refresh button. */
export async function subscribeRealtime(onChange) {
  const sb = await getClient();
  const householdId = await db.meta.get('household_id');
  if (!sb || !householdId) return null;
  const channel = sb.channel('household:' + householdId);
  for (const table of Object.values(TABLES)) {
    channel.on('postgres_changes',
      { event: '*', schema: 'public', table, filter: `household_id=eq.${householdId}` },
      () => onChange());
  }
  channel.subscribe();
  return channel;
}
