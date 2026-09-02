// Security-rules tests, run against the Firestore emulator.
//
//   cd expenses/firebase/tests && npm install && npm test
//
// These are the tests that matter most in this project: the rules are the only
// thing standing between one family's ledger and everyone else's, and a rule
// that is subtly too permissive fails silently — nothing errors, the data is
// just readable by people who should not see it.

import assert from 'node:assert/strict';
import { test, before, after, beforeEach, describe } from 'node:test';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs, updateDoc,
} from 'firebase/firestore';

let env;

const OWNER = 'uid-ernest';
const SPOUSE = 'uid-spouse';
const STRANGER = 'uid-stranger';
const HOUSE = 'house-aks';
const OTHER_HOUSE = 'house-someone-else';
const CODE = 'ABCD2345';

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'family-ledger-rules-test',
    firestore: {
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => { if (env) await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  // Seed a household that OWNER owns and SPOUSE has joined, bypassing rules.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'households', HOUSE),
      { name: 'The AKs', currency: 'GHS', invite_code: CODE, created_by: OWNER });
    await setDoc(doc(db, 'households', HOUSE, 'members', OWNER),
      { role: 'owner', display_name: 'Ernest' });
    await setDoc(doc(db, 'households', HOUSE, 'members', SPOUSE),
      { role: 'member', display_name: 'Spouse', invite_code: CODE });
    await setDoc(doc(db, 'inviteCodes', CODE), { household_id: HOUSE, created_by: OWNER });
    await setDoc(doc(db, 'households', HOUSE, 'transactions', 't1'),
      { household_id: HOUSE, kind: 'expense', amount: 5000, occurred_on: '2026-09-01' });

    await setDoc(doc(db, 'households', OTHER_HOUSE),
      { name: 'Someone Else', currency: 'GHS', invite_code: 'ZZZZ9999', created_by: STRANGER });
    await setDoc(doc(db, 'households', OTHER_HOUSE, 'members', STRANGER), { role: 'owner' });
    await setDoc(doc(db, 'households', OTHER_HOUSE, 'transactions', 't9'),
      { household_id: OTHER_HOUSE, kind: 'income', amount: 999999, occurred_on: '2026-09-01' });
  });
});

describe('the ledger is private to its household', () => {
  test('a member reads and writes their own household ledger', async () => {
    const db = as(SPOUSE);
    await assertSucceeds(getDoc(doc(db, 'households', HOUSE, 'transactions', 't1')));
    await assertSucceeds(setDoc(doc(db, 'households', HOUSE, 'transactions', 't2'),
      { household_id: HOUSE, kind: 'income', amount: 100, occurred_on: '2026-09-02' }));
    await assertSucceeds(getDocs(collection(db, 'households', HOUSE, 'transactions')));
  });

  test('a non-member cannot read another household ledger', async () => {
    const db = as(STRANGER);
    await assertFails(getDoc(doc(db, 'households', HOUSE, 'transactions', 't1')));
    await assertFails(getDocs(collection(db, 'households', HOUSE, 'transactions')));
  });

  test('a non-member cannot write into another household ledger', async () => {
    const db = as(STRANGER);
    await assertFails(setDoc(doc(db, 'households', HOUSE, 'transactions', 'evil'),
      { household_id: HOUSE, kind: 'expense', amount: 1 }));
    await assertFails(deleteDoc(doc(db, 'households', HOUSE, 'transactions', 't1')));
  });

  test('a signed-out visitor gets nothing', async () => {
    const db = anon();
    await assertFails(getDoc(doc(db, 'households', HOUSE, 'transactions', 't1')));
    await assertFails(getDoc(doc(db, 'households', HOUSE)));
  });

  test('every synced collection is covered, not just transactions', async () => {
    const stranger = as(STRANGER);
    const member = as(OWNER);
    for (const table of ['accounts', 'categories', 'people', 'budgets', 'rules']) {
      await assertFails(setDoc(doc(stranger, 'households', HOUSE, table, 'x'),
        { household_id: HOUSE, name: 'x' }));
      await assertSucceeds(setDoc(doc(member, 'households', HOUSE, table, 'x'),
        { household_id: HOUSE, name: 'x' }));
    }
  });

  test('an unknown collection under a household is refused even to a member', async () => {
    // The rule lists the six synced collections; anything else is not ours.
    await assertFails(setDoc(doc(as(OWNER), 'households', HOUSE, 'secrets', 'x'), { a: 1 }));
  });
});

describe('membership can only be granted, never taken', () => {
  test('a stranger cannot add themselves without a code', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', HOUSE, 'members', STRANGER),
      { role: 'member', display_name: 'Intruder' }));
  });

  test('a stranger cannot claim owner on someone else\'s household', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', HOUSE, 'members', STRANGER),
      { role: 'owner', display_name: 'Intruder' }));
  });

  test('a valid invite code lets you add yourself as a member', async () => {
    await assertSucceeds(setDoc(doc(as(STRANGER), 'households', HOUSE, 'members', STRANGER),
      { role: 'member', display_name: 'Invited', invite_code: CODE }));
  });

  test('a wrong or unknown invite code is refused', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', HOUSE, 'members', STRANGER),
      { role: 'member', display_name: 'Guesser', invite_code: 'WRONGGGG' }));
  });

  test('another household\'s code does not open this one', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', HOUSE, 'members', STRANGER),
      { role: 'member', display_name: 'Confused', invite_code: 'ZZZZ9999' }));
  });

  test('a code does not let you write somebody else in', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', HOUSE, 'members', 'uid-victim'),
      { role: 'member', display_name: 'Not me', invite_code: CODE }));
  });

  test('a member cannot promote themselves to owner', async () => {
    await assertFails(updateDoc(doc(as(SPOUSE), 'households', HOUSE, 'members', SPOUSE),
      { role: 'owner' }));
  });

  test('a member can rename themselves', async () => {
    await assertSucceeds(updateDoc(doc(as(SPOUSE), 'households', HOUSE, 'members', SPOUSE),
      { display_name: 'Mrs A' }));
  });

  test('a member can leave; a stranger cannot evict anyone', async () => {
    await assertFails(deleteDoc(doc(as(STRANGER), 'households', HOUSE, 'members', SPOUSE)));
    await assertSucceeds(deleteDoc(doc(as(SPOUSE), 'households', HOUSE, 'members', SPOUSE)));
  });

  test('an owner can remove a member', async () => {
    await assertSucceeds(deleteDoc(doc(as(OWNER), 'households', HOUSE, 'members', SPOUSE)));
  });
});

describe('creating a household', () => {
  test('the creator can create it and then own it', async () => {
    const db = as(STRANGER);
    const id = 'house-new';
    await assertSucceeds(setDoc(doc(db, 'households', id),
      { name: 'New Home', currency: 'GHS', invite_code: 'QQQQ7777', created_by: STRANGER }));
    await assertSucceeds(setDoc(doc(db, 'households', id, 'members', STRANGER),
      { role: 'owner', display_name: 'Founder' }));
    await assertSucceeds(setDoc(doc(db, 'inviteCodes', 'QQQQ7777'),
      { household_id: id, created_by: STRANGER }));
  });

  test('you cannot create a household in someone else\'s name', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', 'house-forged'),
      { name: 'Forged', currency: 'GHS', invite_code: 'FFFF1111', created_by: OWNER }));
  });

  test('an unnamed household is refused', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'households', 'house-blank'),
      { name: '', currency: 'GHS', invite_code: 'BBBB2222', created_by: STRANGER }));
  });

  test('only an owner may rename a household, and never reassign it', async () => {
    await assertFails(updateDoc(doc(as(SPOUSE), 'households', HOUSE), { name: 'Renamed' }));
    await assertSucceeds(updateDoc(doc(as(OWNER), 'households', HOUSE), { name: 'The AKs 2' }));
    await assertFails(updateDoc(doc(as(OWNER), 'households', HOUSE), { created_by: SPOUSE }));
  });
});

describe('invite codes', () => {
  test('a signed-in user may resolve a code, because that is how joining works', async () => {
    await assertSucceeds(getDoc(doc(as(STRANGER), 'inviteCodes', CODE)));
  });

  test('a signed-out visitor may not', async () => {
    await assertFails(getDoc(doc(anon(), 'inviteCodes', CODE)));
  });

  test('codes cannot be enumerated', async () => {
    await assertFails(getDocs(collection(as(STRANGER), 'inviteCodes')));
  });

  test('a code cannot be repointed at another household', async () => {
    await assertFails(updateDoc(doc(as(STRANGER), 'inviteCodes', CODE), { household_id: OTHER_HOUSE }));
    await assertFails(updateDoc(doc(as(OWNER), 'inviteCodes', CODE), { household_id: OTHER_HOUSE }));
  });

  test('you cannot mint a code for a household you are not in', async () => {
    await assertFails(setDoc(doc(as(STRANGER), 'inviteCodes', 'HACK0001'),
      { household_id: HOUSE, created_by: STRANGER }));
  });

  test('only an owner can revoke a code', async () => {
    await assertFails(deleteDoc(doc(as(SPOUSE), 'inviteCodes', CODE)));
    await assertSucceeds(deleteDoc(doc(as(OWNER), 'inviteCodes', CODE)));
  });
});

describe('the per-user household index is private', () => {
  test('you can read and write your own', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), 'users', OWNER, 'households', HOUSE),
      { name: 'The AKs', role: 'owner' }));
    await assertSucceeds(getDocs(collection(as(OWNER), 'users', OWNER, 'households')));
  });

  test('you cannot read or write anyone else\'s', async () => {
    await assertFails(getDocs(collection(as(STRANGER), 'users', OWNER, 'households')));
    await assertFails(setDoc(doc(as(STRANGER), 'users', OWNER, 'households', HOUSE), { name: 'x' }));
  });
});
