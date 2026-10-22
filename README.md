# Atlas Recovery: Account Lookup

Prototype that lets CollectWise's AI agent look up Atlas Recovery debtor accounts by
account number. Atlas uploads a CSV of their inventory; an ingestion script loads it
into SQLite; an HTTP endpoint serves lookups to the agent.

> Status: ingestion and the lookup API are complete and tested. The API key and
> deployment are next.

## Requirements

- Node.js 22+
- No external database: SQLite runs in-process (`better-sqlite3`), stored at `data/atlas.db`.

## Quick start

```bash
npm install
npm run ingest -- data/sample_atlas_inventory.csv   # load the sample file
npm start                                           # serve the API on port 3000 (or PORT)
curl localhost:3000/accounts/10024500               # look up an account
npm test                                            # run the test suite
```

With no argument, `npm run ingest` reads `./atlas_inventory.csv`.

The sample file contains 51 rows: 43 valid ones in a mix of real-world formats
(`$1,250.50`, `(214) 555-0101`, `ACTIVE`, a byte-order mark from Excel, one account
with status `Paid`) and 8 deliberately invalid ones, so you can see how each problem
is reported.

## CSV format

The file must be saved as UTF-8 (in Excel: Save As, "CSV UTF-8"). Required columns
(header names are case-insensitive; extra columns are ignored):

| Column | Rules |
|---|---|
| `account_number` | Letters and digits. Spaces and dashes are removed and letters uppercased, so `ab-1234` is stored as `AB1234`. Leading zeros are kept. |
| `debtor_name` | Required. |
| `phone_number` | US number, 10 digits (or 11 starting with 1), any common formatting. Stored as `+12145550123`. |
| `balance` | Zero or more, at most 2 decimals. `$` and thousands commas (`1,250.50`) allowed; a decimal comma (`12,50`) is rejected rather than read as 1250. |
| `status` | Required. `Active` and `Closed` are case-insensitive; any other value (`Disputed`, `Bankruptcy`, ...) is stored as given. See *Statuses* under [Ingestion rules](#ingestion-rules). |
| `client_name` | Required. |

## Ingestion rules

**Repeat uploads.** Each upload is upserted by `account_number`: new accounts are
inserted, existing ones are overwritten with the new values. Accounts are never deleted,
and an account absent from a later file is left as is, so ingestion is safe whether
Atlas sends full inventories or only changes. Closures are expected to arrive as
`status = Closed`; an account is never assumed closed because it is missing from a file.

**Rejected rows.** A row with any invalid or missing field is skipped and listed in the
summary with every problem found. Invalid data never overwrites valid data. If the
account is already on file, its previous data is kept, but the account is **held for
review** (`needs_review`): the rejected row may have carried a change we couldn't apply,
such as a new balance or a dispute, so the data on file may be out of date. The agent
must not act on a held account. The hold lifts when a later upload contains a valid row
for it. A rejected row for an account not yet on file adds nothing.

**Duplicate account numbers in one file.** Every occurrence is rejected, because the
file doesn't say which version is correct. As with any rejected row, an account already
on file is held for review and a new one is not added. The summary says whether the copies were
identical (likely an export glitch) or conflicting (needs review). Once Atlas corrects
the file, re-uploading it applies the fix.

**Negative balances** are rejected and flagged for manual review, since they usually
mean an overpayment, which shouldn't go to an automated collection call.

**Statuses.** Status decides whether the agent may ask for payment, and several common
statuses (a disputed debt, a bankruptcy, a request to stop contact) legally require
collection to stop. So:
- Any non-empty status is accepted. A value like `Disputed` is real information, not
  a data error. Rejecting it would put the account on a hold Atlas has no way to clear,
  hide the dispute from the agent, and could push a file that uses such values past the
  20% rejection limit.
- Only `Active` is collectible. The API returns the status as stored, and the agent
  discusses payment only when it is exactly `Active` and the account isn't held for
  review. Anything else, including a typo like `Actve`, means no collection, so an
  unexpected value fails safe.
- The upload summary counts accounts by status (`By status: Active 29, Closed 13,
  Paid 1`), so an unexpected value is easy to spot.

Which statuses allow collection is Atlas's decision; the email to Atlas asks for the
full list of values they use.

**Whole-file aborts.** Nothing is written, not even review holds, if:
- the file isn't UTF-8. Excel's plain "CSV" format on Windows uses an older encoding,
  and reading it anyway would store every accented name garbled (`José` as `Jos�`)
  without an error. It's a one-step fix on Atlas's side, so the file is refused with
  instructions rather than partly loaded,
- a required column is missing from the header,
- the file has no data rows, or
- more than 20% of rows are rejected, which usually means a malformed export rather
  than a few bad rows. Override with `INGEST_FAILURE_THRESHOLD=0.3`.

**Safety.** All writes happen in one transaction, so an upload is applied completely or
not at all. Before each upload, the existing database is copied to `data/atlas.db.bak`;
to roll back a bad upload, copy that file back over `data/atlas.db`. Re-running the same
file is safe and produces the same result.

**Timestamps.** `created_at` is set when an account first appears. `updated_at` is set
to the time of every upload that includes the account. All rows from one upload share
the same `updated_at`, so a record can be traced to the file it came from, provided
Atlas keeps copies of past uploads (date-stamped filenames are recommended).

## Lookup API

`GET /accounts/:accountNumber` returns one account. The account number is normalized
exactly as at ingestion, so `1002-9911` finds `10029911`; the agent hears numbers read
aloud and may pass them with spaces or dashes. Leading zeros count: `00031822` and
`31822` are different accounts.

```bash
curl localhost:3000/accounts/10024500
```

```json
{
  "account_number": "10024500",
  "debtor_name": "Maria Garcia",
  "phone_number": "+12145550100",
  "balance": 50,
  "balance_formatted": "$50.00",
  "balance_as_of": "2026-10-22T13:43:18.307Z",
  "status": "Active",
  "client_name": "Alpha Bank",
  "needs_review": false
}
```

| Field | Notes |
|---|---|
| `balance` | Dollars, as a number. |
| `balance_formatted` | The same amount, ready to be read aloud, so the agent doesn't format money itself. |
| `balance_as_of` | When the upload containing this balance was loaded (UTC). Payments made since aren't reflected, so the agent should say "as of" this date. |
| `status` | As Atlas sent it. Only `Active` is collectible; see *Statuses* above. |
| `needs_review` | `true` when the account is held for review. |

**Held accounts** (`needs_review: true`) come back with `balance`, `balance_formatted`,
`balance_as_of` and `status` set to `null`. Their data may be out of date, so the API
withholds anything the agent could quote instead of relying on the agent to ignore it.
A held account can still come up, for example when a debtor calls in with their account
number, so this can't be left to whoever decides which accounts to call. The identity
fields remain, so the agent can confirm who it is talking to and say someone will
follow up. The keys are always present, so the response shape never changes.

**Closed and other non-`Active` accounts** are returned normally, not as a 404, so the
agent can tell "closed" apart from "no such account".

**Errors** always have the same shape, `{ "error": "<code>", "message": "<text>" }`, so
the agent can branch on `error`. Express's default HTML error pages are replaced; the
agent only ever receives JSON.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_account_number` | Empty, or contains anything other than letters and digits once spaces and dashes are removed. |
| 400 | `bad_request` | The URL itself is malformed, such as a broken `%` escape. |
| 404 | `account_not_found` | No account with that number. |
| 404 | `not_found` | Unknown route or method. |
| 500 | `internal_error` | Unexpected failure. Details are logged on the server, never returned. |

`GET /health` returns `{ "ok": true }` after a trivial database query. It's for the
host's health check and uptime monitoring, and returns no account data.

## Project layout

```
src/schema.sql     table and index definitions
src/db.js          opens the database and applies the schema
src/validate.js    field parsing and validation (shared with the API)
src/ingest.js      CSV ingestion CLI
src/server.js      lookup API (Express)
test/              unit and integration tests (node:test)
data/              sample CSV; the database file is created here
```

## Production notes

Deliberately left out of this prototype:
- **Phone validation** checks digit count only. A library such as `libphonenumber-js`
  could also verify area codes. International numbers are rejected.
- **Upload history** (who uploaded what, when) is not recorded beyond `updated_at`.
