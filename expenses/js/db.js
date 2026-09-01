// IndexedDB is the source of truth for the running app. Every read and every
// write is local, so the app is instant and works with no network at all;
// Supabase is a replica that sync.js pushes to and pulls from.

export const STORES = ['accounts', 'categories', 'people', 'transactions', 'budgets', 'rules'];
const DB_NAME = 'family-ledger';
const DB_VERSION = 1;

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('dirty', '_dirty');
        if (name === 'transactions') {
          store.createIndex('occurred_on', 'occurred_on');
          store.createIndex('account_id', 'account_id');
          store.createIndex('category_id', 'category_id');
          store.createIndex('external_ref', 'external_ref');
        }
        if (name === 'budgets') store.createIndex('month', 'month');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName), tx);
    tx.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function wrap(request) {
  const box = { __value: undefined };
  request.onsuccess = () => { box.__value = request.result; };
  return box;
}

export const get      = (store, id)  => run(store, 'readonly',  s => wrap(s.get(id)));
export const all      = (store)      => run(store, 'readonly',  s => wrap(s.getAll()));
export const put      = (store, row) => run(store, 'readwrite', s => { s.put(row); return row; });
export const putMany  = (store, rows) => run(store, 'readwrite', s => { rows.forEach(r => s.put(r)); return rows.length; });
export const hardDelete = (store, id) => run(store, 'readwrite', s => { s.delete(id); });
export const clear    = (store)      => run(store, 'readwrite', s => { s.clear(); });

export const dirtyRows = (store) =>
  run(store, 'readonly', s => wrap(s.index('dirty').getAll(IDBKeyRange.only(1))));

export const findByIndex = (store, index, value) =>
  run(store, 'readonly', s => wrap(s.index(index).getAll(IDBKeyRange.only(value))));

// -------------------------------------------------------------------- meta
// Small key/value bag: session pointers, sync cursors, UI preferences.

export const meta = {
  get: (key) => run('meta', 'readonly', s => wrap(s.get(key))).then(r => (r ? r.value : undefined)),
  set: (key, value) => run('meta', 'readwrite', s => { s.put({ key, value }); return value; }),
  del: (key) => run('meta', 'readwrite', s => { s.delete(key); }),
};

/** Wipe every local table — used when switching household or signing out. */
export async function wipeLocal() {
  for (const store of STORES) await clear(store);
  await meta.del('sync_cursors');
}
