# Atlas Recovery: Account Lookup

Prototype that lets CollectWise's AI agent look up Atlas Recovery debtor accounts by
account number. Atlas uploads a CSV of their inventory; an ingestion script loads it
into SQLite; an HTTP endpoint serves lookups to the agent.

> Status: ingestion is complete and tested. The lookup API and deployment are next.

## Requirements

- Node.js 22+
- No external database: SQLite runs in-process (`better-sqlite3`), stored at `data/atlas.db`.

## Quick start

```bash
npm install
npm run ingest -- data/sample_atlas_inventory.csv   # load the sample file
npm test                                            # run the test suite
```

With no argument, `npm run ingest` reads `./atlas_inventory.csv`.

The sample file contains 51 rows: 42 valid ones in a mix of real-world formats
(`$1,250.50`, `(214) 555-0101`, `ACTIVE`, a byte-order mark from Excel) and 9
deliberately invalid ones, so you can see how each problem is reported.

## CSV format

Required columns (header names are case-insensitive; extra columns are ignored):

| Column | Rules |
|---|---|
| `account_number` | Letters and digits. Spaces and dashes are removed and letters uppercased, so `ab-1234` is stored as `AB1234`. Leading zeros are kept. |
| `debtor_name` | Required. |
| `phone_number` | US number, 10 digits (or 11 starting with 1), any common formatting. Stored as `+12145550123`. |
| `balance` | Zero or more, at most 2 decimals. `$` and commas allowed. |
| `status` | `Active` or `Closed`, case-insensitive. |
| `client_name` | Required. |

## Ingestion rules

**Repeat uploads.** Each upload is upserted by `account_number`: new accounts are
inserted, existing ones are overwritten with the new values. Accounts are never deleted,
and an account absent from a later file is left as is, so ingestion is safe whether
Atlas sends full inventories or only changes. Closures are expected to arrive as
`status = Closed`; an account is never assumed closed because it is missing from a file.

**Rejected rows.** A row with any invalid or missing field is skipped and listed in the
summary with every problem found. If the account already exists, its previous data is
kept unchanged. Invalid data never overwrites valid data.

**Duplicate account numbers in one file.** Every occurrence is rejected, because the
file doesn't say which version is correct. The summary says whether the copies were
identical (likely an export glitch) or conflicting (needs review). Once Atlas corrects
the file, re-uploading it applies the fix.

**Negative balances** are rejected and flagged for manual review, since they usually
mean an overpayment, which shouldn't go to an automated collection call.

**Whole-file aborts.** Nothing is written if:
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

## Project layout

```
src/schema.sql     table and index definitions
src/db.js          opens the database and applies the schema
src/validate.js    field parsing and validation (shared with the API)
src/ingest.js      CSV ingestion CLI
test/              unit and integration tests (node:test)
data/              sample CSV; the database file is created here
```

## Production notes

Deliberately left out of this prototype:
- **Phone validation** checks digit count only. A library such as `libphonenumber-js`
  could also verify area codes. International numbers are rejected.
- **Upload history** (who uploaded what, when) is not recorded beyond `updated_at`.
