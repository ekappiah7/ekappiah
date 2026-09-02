# Family Ledger

A household ledger that tracks **what comes in** as well as what goes out, because
every number worth knowing — net flow, savings rate, how many months of cover you
have — is a ratio with income on one side of it. An expenses-only app can tell you
that you spent GHS 3,200 this month. It cannot tell you whether that was fine.

Offline-first: everything is written to IndexedDB on the device and works with no
network at all. Add a free Firebase project and the same ledger syncs across every
phone in the house, each person signing in as themselves.

- **Deploy**: `firebase deploy` from the repo root. Nothing to build — it is plain
  ES modules and CSS. The project is `jaksexp`, so the app lands at
  **https://jaksexp.web.app/**.
- **Locally**: `python3 -m http.server 8000` from the repo root, then open
  `http://localhost:8000/`. (Serve it over `http://`, not `file://` — ES modules and
  service workers need an origin.)

---

## What it does

**Ledger.** Three kinds of entry: money in, money out, and transfers. A transfer
moves value between two of your own accounts and is deliberately excluded from
income and spending totals — counting a bank-to-MoMo move as both an inflow and an
outflow is the single most common way a family budget ends up lying to you.

**Accounts.** Cash, MTN MoMo, bank, savings, cards and loans, each with an opening
balance and a running balance derived from the ledger rather than stored.

**Categories.** Two trees, one for inflows and one for outflows, so income
categories never turn up in a spending picker. Seeded with the lines a Ghanaian
household actually uses — ECG, tithe and offering, funerals and donations, family
support, school fees, MoMo fees — and each top-level category can be marked
*essential*, which is what drives the needs-vs-wants split.

**People.** Tag who a spend was for. It is the difference between "GHS 800 on
transport" and "GHS 800 taking the kids to school".

**Budgets.** A monthly figure per category, with spend rolled up from
sub-categories, and a one-click copy of last month's set.

**Recurring rules.** Rent, salary, school fees. Rules never post silently — they
queue what is due and you confirm it. A rent that quietly recorded itself while it
was actually still unpaid is worse than no automation at all.

**Import.** Paste a MoMo SMS thread, or upload a bank CSV. Both produce a draft
table you review, edit and categorise before anything is committed; entries already
in the ledger are dropped by transaction id or by date+amount, and messages the
parser could not read are listed rather than silently discarded.

**Insights.** Money in vs money out per month, savings rate over time, where the
money went, where it came from (income concentrated in one source is a risk worth
seeing), essentials vs everything else, who spent it, and months of cover.

**Export.** CSV of any filtered view, or a full JSON backup.

---

## Money and correctness

Amounts are stored as an **integer number of pesewas**, never as floats. A ledger
that drifts by a pesewa a month is a ledger nobody trusts. `js/money.js` parses
`1,234.50`, `GHS 1234.5`, `₵3,000` and `(1,200)` into the same integer
representation and is the only place currency formatting happens.

---

## Setting up family sharing

Everything above works with no account. These steps add sync. The free Spark plan
is enough — nothing here uses Cloud Functions, deliberately, so no billing account
is required.

1. **Create a Firebase project** at [console.firebase.google.com](https://console.firebase.google.com).
2. **Enable Email/Password sign-in**: Authentication → Sign-in method → Email/Password
   → Enable. (Leave "Email link" off.)
3. **Create a Firestore database**: Firestore Database → Create database → start in
   **production mode** and pick a region close to you (`europe-west1` is a reasonable
   default from Ghana). Production mode denies everything until step 4, which is
   what you want.
4. **Deploy the rules**, from the repo root. `.firebaserc` already points at the
   `jaksexp` project, so no `--project` flag is needed:
   ```sh
   npm install -g firebase-tools     # once
   firebase login                    # once
   firebase deploy --only firestore:rules
   ```
   Nothing works until these are deployed — production mode denies all reads and
   writes by default, and the rules in `firebase/firestore.rules` are what grant
   household members access to their own data.
5. **Register a web app**: Project settings → Your apps → Web (`</>`). Copy the
   `firebaseConfig` block it shows you.
6. **Open the app → Settings → Family sharing** and paste that whole block in — the
   `const firebaseConfig = { ... }` snippet as-is, comments and all. The web API key
   is designed to ship in client code; the security rules are what protect the data,
   not key secrecy.
7. **Create an account, then create a household.** You get an 8-character invite
   code.
8. **On each family member's phone**: open the same URL, paste the same config,
   create their own account, and **Join** with the invite code. Everyone then sees
   the same ledger, and each entry records who created it.
9. **Deploy the app itself** whenever you like: `firebase deploy --only hosting`.

Add the page to the home screen on Android or iOS and it runs like an app.

### How sync works

```
households/{hid}                    name, currency, invite code
households/{hid}/members/{uid}      who may read and write it
households/{hid}/{table}/{id}       accounts, categories, people,
                                    transactions, budgets, rules
inviteCodes/{CODE}                  code -> household, so a code can be redeemed
users/{uid}/households/{hid}        each person's own list
```

Every synced document carries `household_id`, `updated_at` and a `deleted`
tombstone. The app pushes locally-changed rows first in batched writes, lets the
server stamp `updated_at` with `serverTimestamp()`, then pulls everything stamped
at or after its cursor. Last write to reach the server wins, which for a household
of a few phones is what people actually expect. Because deletes are tombstones
rather than real deletes, a row deleted on one phone disappears on the others
instead of coming back to life on their next push. Locally edited rows are never
overwritten by a pull before they have been pushed.

Firestore has no stored procedures, so creating and joining a household are
ordinary client writes and `firebase/firestore.rules` is what makes them safe. The
whole model is one invariant: **you may touch a document only while you are a
member of the household it lives under.** Membership itself can only be created two
ways — you created the household, or you presented an invite code that resolves to
it — and either way you can only add *yourself*, so nobody can write another person
into a household or promote themselves to owner.

Realtime listeners watch only the newest document in each collection, which is
enough to know something changed without paying to stream the whole ledger. If you
would rather not use them, delete the `subscribeRealtime` call in `js/app.js`;
syncing on open still catches everything.

### If Firebase cannot be reached

The SDK is fetched from `gstatic.com` at runtime. If that is blocked or the network
is down, the app says so explicitly and keeps working on the device — your entries
queue as unsynced and go up on the next successful sync. It never silently reverts
to looking unconfigured. The fetch also has a timeout, because a filtering proxy
can leave the request hanging rather than refusing it.

You can take gstatic out of the loop entirely by serving the SDK yourself:

```sh
sh vendor/fetch-sdk.sh
```

Then add `"sdk_base": "/vendor/firebase"` to the config you paste into
Settings. Firebase Hosting then serves the SDK from your own origin — one fewer
third party, and immune to gstatic being blocked. The files are gitignored, so run
the script again after a fresh clone.

---

## Tests

The security rules are the only thing standing between one family's ledger and
everyone else's, and a rule that is subtly too permissive fails *silently* —
nothing errors, the data is just readable by people who should not see it. So they
are tested rather than eyeballed.

```sh
cd firebase
npm install
npm test        # 28 security-rules tests against the Firestore emulator
```

Covered: a member reads and writes their own household; a non-member and a
signed-out visitor are refused on every one of the six synced collections; invite
codes can be redeemed but not enumerated, repointed, or minted for a household you
are not in; membership can only ever be created for *yourself*, and only by the
household's creator or with a valid code; a member cannot promote themselves to
owner; and each person's household index is private to them.

These were mutation-checked — with the ledger rule loosened to `if signedIn()`,
11 of the 28 fail; with the invite-code check removed from membership creation,
4 fail. A suite that stays green against broken rules would be worse than none.

There is also an end-to-end test that drives the real app in a real browser across
**two devices**, against the Auth and Firestore emulators:

```sh
sh vendor/fetch-sdk.sh          # serve the SDK locally
python3 -m http.server 8777 &   # from the repo root
cd firebase && npm run test:e2e
```

It signs up two people, creates a household, joins it with the invite code, and
checks that entries and *deletions* propagate both ways, that a joining device ends
up with exactly one set of default accounts and categories, and that a third,
non-member account is refused and leaks nothing. That last pair of checks exists
because the first version failed them: a joining device kept its own seeded
defaults (giving a duplicate of every category) and pushed them into the household
it was joining.

### Developing against the emulators

Add an `emulator` key to the config you paste into Settings and the app talks to
local emulators instead of your real project:

```json
{ "apiKey": "demo", "authDomain": "localhost", "projectId": "jaksexp",
  "appId": "1:1:web:1",
  "emulator": { "host": "127.0.0.1", "authPort": 9099, "firestorePort": 8080 } }
```

---

## Files

```
├── index.html            app shell — bottom tabs, add button, sheet, toast
├── app.css               design tokens, light + selected dark palette
├── sw.js                 caches the shell for offline; never touches data
├── manifest.webmanifest  installable PWA
├── js/
│   ├── app.js            state, routing, every view, all form handlers
│   ├── store.js          domain model, seed data, and all analytics
│   ├── db.js             IndexedDB — the source of truth while running
│   ├── cloud.js          Firebase auth, households, push/pull sync
│   ├── importers.js      CSV parser + MoMo SMS parser + dedupe
│   ├── charts.js         inline SVG charts, no dependencies
│   └── money.js          integer minor units, parsing and formatting
├── vendor/
│   ├── fetch-sdk.sh      optional: serve the Firebase SDK from your own origin
│   ├── fetch-fonts.sh    re-fetch the self-hosted webfonts
│   └── fonts/            Playfair Display + Inter, committed
├── firebase.json         Hosting + Firestore deploy config
├── .firebaserc           names the jaksexp project
└── firebase/
    ├── firestore.rules        membership rules — the whole access model
    ├── firestore.indexes.json (empty: every query is single-field)
    ├── firebase.json          emulator config, for the tests only
    └── tests/
        ├── rules.test.mjs     28 security-rules tests
        └── sync.e2e.mjs       two-device sync, in a real browser
```

Everything runs from the **repo root** — that is where `firebase deploy` looks for
`firebase.json`, and where a static server should be pointed when developing.

## Colour and type

The AKs palette: **navy brown, gold, cream.** One rule shapes the whole interface —
**gold lives on the navy, never on the cream.** That is measured, not a preference:
gold on cream is 2.28:1 and fails, gold on navy brown is 5.93:1 and passes
comfortably. So gold has exactly two homes, the hero panel and the tab bar, and a
deeper gold (`--gold-ink`, 4.7:1) is kept for the one place gold must touch cream —
the date headings in the ledger.

Cream is the ground, navy brown is the ink, and the hero is a navy panel so the
brand reads the moment the app opens.

To match the brand exactly, change `--navy`, `--gold` and `--cream` at the top of
`app.css`. Everything else derives from them by role.

Underneath that, colour still means data: **money in is blue, money out is red**, in
both themes, always — colour follows the entity, never its rank. Both were
re-validated against the cream card *and* the navy panel in both modes and clear
every gate (CVD ΔE 21.6 light / 19.2 dark against a ≥8 target; contrast ≥3:1 on
every surface they appear on). Category and per-person breakdowns are a single hue,
because identity there lives on the axis and a rainbow would encode nothing. Dark
mode is its own set of steps, not an inversion.

Type is **Playfair Display** for the things that carry the brand — the app title,
section headings, the month, and the hero figure — with **Inter** for everything
else, because dense rows of money want a sans with real tabular figures. Both are
self-hosted from `vendor/fonts/` (latin subsets, committed), so there is no
third-party request on load and the type survives going offline. Re-fetch or bump
versions with `sh vendor/fetch-fonts.sh`.

## Known limits

- Single currency per household (GHS by default). Multi-currency accounts would need
  a rate table and a reporting currency; the schema has a `currency` column per
  account ready for it, but nothing converts yet.
- Conflict resolution is last-write-wins per document. Two people editing the *same*
  entry within the same few seconds will keep one of the two edits, not merge them.
- Household creation writes three documents in sequence rather than atomically,
  because the membership rule has to read the household document and a batch would
  evaluate every write against the state before the batch. If it fails halfway,
  creating the household again is safe.
- Leaving a household removes your membership but does not delete the ledger; an
  owner clearing out an old household does it from the Firebase console.
- The MoMo parser covers the common MTN and Vodafone Cash phrasings. Anything it
  cannot read is shown in the "unread messages" list — send the format along and it
  is a few lines to add.
