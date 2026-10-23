# Atlas Recovery: Account Lookup

Prototype that lets CollectWise's AI agent look up Atlas Recovery debtor accounts by
account number. Atlas uploads a CSV of their inventory; an ingestion script loads it
into SQLite; an HTTP endpoint serves lookups to the agent.

> Status: ingestion, the lookup API, the live deployment and the Retell agent are
> complete and tested.

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

The sample file contains 52 rows: 44 valid ones in a mix of real-world formats
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
- The upload summary counts accounts by status (`By status: Active 30, Closed 13,
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

**API key.** The endpoint returns debtors' names, phone numbers and balances, and
account numbers are easy to guess, so a public deployment must not be open. When the
`API_KEY` environment variable is set, `/accounts` requires it in an `x-api-key` header.
A missing or wrong key gets a 401, checked before anything else, so no lookup runs.
When `API_KEY` isn't set (local runs, tests), the API is open so it can be tried without
setup, and the server prints a warning at startup. `/health` never needs the key:
hosting health checks can't send headers, and it returns no account data.

```bash
API_KEY=my-local-key npm start
curl -H "x-api-key: my-local-key" localhost:3000/accounts/10024500
```

The key goes in a header rather than the URL because servers and proxies routinely log
URLs. The deployed instance's key is shared with reviewers separately, never committed.

**Errors** always have the same shape, `{ "error": "<code>", "message": "<text>" }`, so
the agent can branch on `error`. Express's default HTML error pages are replaced; the
agent only ever receives JSON.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_account_number` | Empty, or contains anything other than letters and digits once spaces and dashes are removed. |
| 400 | `bad_request` | The URL itself is malformed, such as a broken `%` escape. |
| 401 | `unauthorized` | `API_KEY` is set and the `x-api-key` header is missing or wrong. |
| 404 | `account_not_found` | No account with that number. |
| 404 | `not_found` | Unknown route or method. |
| 500 | `internal_error` | Unexpected failure. Details are logged on the server, never returned. |

`GET /health` returns `{ "ok": true }` after a trivial database query. It's for the
host's health check and uptime monitoring, and returns no account data.

## Deployment

The public demo runs on Render's free tier:

**https://atlas-account-lookup-8a5s.onrender.com**

```bash
curl -H "x-api-key: <key>" https://atlas-account-lookup-8a5s.onrender.com/accounts/10024500
```

The key is sent with the submission, not committed. Some accounts to try:

| Request | Shows |
|---|---|
| `/accounts/10024500` | An active account: $50.00 |
| `/accounts/10020001` | John Doe, $2,400.00: the account the Retell agent's script uses |
| `/accounts/1002-9911` | Dashes ignored: finds `10029911` |
| `/accounts/00031822` | A closed account, leading zeros kept |
| `/accounts/12345678` | 404 `account_not_found` |
| Any account, no key | 401 `unauthorized` |

**To test with your own CSV, run it locally** (see Quick start). The public instance
serves only the sample file. There is deliberately no upload endpoint: anything that
writes to the database is a much bigger risk than a read-only lookup, and in production
uploads would come through Atlas's own file transfer instead.

**How it's set up** (`render.yaml`):
- Build: `npm ci`, on Node 24 pinned by `.node-version`. Without the pin, Render would
  pick the newest Node release, and `better-sqlite3` is compiled for specific versions.
- Start: loads `data/sample_atlas_inventory.csv`, then starts the server. Free instances
  have no persistent disk (files are wiped on every restart, redeploy and sleep), so the
  sample is reloaded on each start. It takes under a second. The data is identical each
  time, but `balance_as_of` shows when the server last loaded the file, so it moves
  forward after a restart or wake-up.
- `API_KEY` is generated by Render on first deploy; it's in the service's Environment tab.
- Render's health check calls `/health`.

**To deploy your own copy:** push the repo to GitHub, then in Render choose New >
Blueprint and select the repo. Render reads `render.yaml` and creates the service.

**Free-tier sleep.** After 15 minutes without requests, a free instance sleeps, and the
next request waits about a minute while it starts. Only that first request is slow.
During review, a free uptime monitor (such as UptimeRobot or cron-job.org) requesting
`/health` every 10 minutes keeps it awake; one service running all month uses about 744
of Render's 750 free hours. A production deployment wouldn't sleep (see below).

## Retell agent

`retell/atlas_recovery_agent.json` is the exported Conversation Flow agent. It follows the
assignment's script and looks up the account live through the deployed API.

```
Greeting → Verify identity (last 4 of SSN) → Look up account → Check status → Negotiate ⇄ Confirm terms → Goodbye
   │                │                                              │              │
   └ not John:      └ not verified ─────────────────→ Transfer ←───┘ not Active   └ dispute, or asks for a person → Transfer
     take a message                                    (fails → Goodbye)            refuses, or wants to hang up → Goodbye
     or end politely
```

**How it uses the API.** Once the caller is verified, a function node calls
`GET /accounts/{{account_number}}` and stores `status`, `balance`, `balance_formatted` and
`balance_as_of` as variables. A logic node then checks `status == Active` as an exact
comparison, not an AI judgment. Everything else goes to the transfer: a closed or
disputed account, a held account (its status comes back `null`), an unknown account
(404), or a failed lookup. One check covers every case the agent mustn't collect on.

In production the dialer passes the account number with each outbound call (Retell's
`retell_llm_dynamic_variables`). The agent deliberately has no default for it, so a call
without one fails into the transfer instead of looking up the wrong account. The
function's 2-minute timeout covers the free server waking up: the caller hears "one
moment while I pull up your account", then waits up to a minute.

**To run the exported agent,** import the JSON into Retell, then:
1. In the `lookup_account` function, replace `<API_KEY>` in the `x-api-key` header with the
   key sent with the submission.
2. In the test panel's dynamic variables, set `account_number` to `10020001` (John Doe,
   $2,400.00).

Then answer "yes" and "1234". To hear the transfer, use `00031822` (closed) or
`12345678` (not found) instead.

**Choices beyond the script:**
- **Payment limits.** The script allows at most a 24-month plan and no settlement below
  80%. The agent reads 80% as the minimum total for any terms, whether paid at once or in
  installments. It opens with the full amount, then the script's 3-month plan. If the caller
  proposes terms within the limits, it mentions the 3-month plan once and then accepts.
  Before ending, it reads the terms back and asks the caller to confirm them.
- **Privacy.** Nothing about the debt is said before verification, including to whoever
  answers or takes a message. Telling a third party about a debt is a common
  collections violation.
- **Disputes.** If the caller disputes the debt, says it's already paid, or asks for a
  person, the agent transfers instead of negotiating; collection should stop on a dispute.
  A refusal or a wish to hang up gets a polite goodbye, not more pressure.
- **Transfers.** There's no live-agent line for this demo, and Retell can't transfer web
  calls anyway, so the transfer always fails. The failure path is deliberate: the agent
  apologizes that no one is available and says someone will follow up. In production the
  destination would be Atlas's live-agent queue.
- **Names** are fixed as in the script. In production, the debtor's and client's names
  would arrive with each call, like the account number.
- **Voicemail:** the agent hangs up. Voicemails from collectors have strict content
  rules, so the agent doesn't leave one.

**Tested** with web calls against the live API, on John Doe's account ($2,400.00):
- Paying in full; the 3-month plan (3 × $800.00); changing terms at the read-back, which
  returns to negotiating without starting over.
- Pushing hard: never below $1,920.00 (80%) or past 24 months. An offer within the limits
  ($2,000 today) is accepted; one below them ($1,500) gets a counteroffer.
- Someone else answering: taking a message, or a wrong number, ends politely. Asking
  "What's this about?" before verification never reveals the debt.
- Verification: a wrong answer or a refusal goes to the transfer; "one two three four" and
  "twelve thirty-four" both pass.
- A closed account (`00031822`), an unknown one (`12345678`), and a call with no account
  number all go to the transfer without mentioning a balance. A held account takes the
  same path, but the demo has none (each restart loads one clean file).
- "I don't owe this" goes to the transfer; "I'm hanging up" gets a polite goodbye.
- "How do I pay?" gets no invented website or phone number.
- A cold start: the caller hears "one moment", waits up to a minute while the server wakes,
  and the call continues.

## Project layout

```
src/schema.sql     table and index definitions
src/db.js          opens the database and applies the schema
src/validate.js    field parsing and validation (shared with the API)
src/ingest.js      CSV ingestion CLI
src/server.js      lookup API (Express)
test/              unit and integration tests (node:test)
data/              sample CSV; the database file is created here
retell/            exported Retell agent (API key replaced with <API_KEY>)
render.yaml        Render deployment (free tier demo)
.node-version      Node version for Render
```

## Production notes

Deliberately left out of this prototype:
- **Phone validation** checks digit count only. A library such as `libphonenumber-js`
  could also verify area codes. International numbers are rejected.
- **Upload history** (who uploaded what, when) is not recorded beyond `updated_at`.
- **Access control** is one shared key. Production would give each caller its own key,
  so one can be revoked without affecting the others, and could also verify Retell's
  request signature (`X-Retell-Signature`) so that only the agent can call the endpoint.
- **Hosting** would be an always-on paid instance (no sleep) with a persistent disk, with
  `DB_PATH` pointing at the disk so data survives restarts and deploys.
- **Uploads** would run ingestion automatically when Atlas drops a file (for example,
  into a storage bucket or SFTP folder) instead of someone running `npm run ingest`.
- **Outbound call lists** should exclude held and non-`Active` accounts. Those lists come
  from CollectWise's dialer, not this API, so it needs to check the same rules; the API
  already withholds held accounts' details if one is reached anyway.
- **SSN verification.** The agent checks the script's fixed answer (`1234`); the CSV has
  no SSN column. In production the agent would send the digits to an endpoint that
  answers only "match" or "no match", so real SSN digits never reach the agent's prompt
  or a lookup response.
- **Debt-collector disclosure.** When a third-party agency collects, the FDCPA requires
  telling the debtor the call is from a debt collector. The script's opener doesn't, and it
  introduces the caller as Alpha Bank. The agent follows the script as given. Atlas's
  compliance team should settle the wording, which would go right after verification so
  no one else hears it.
- **Recording the outcome.** Agreed terms exist only in the call transcript. Production
  would record them (with Retell's post-call analysis fields, or a function that sends the
  arrangement to Atlas) so the written confirmation the agent promises actually goes out.
- **Payment arithmetic.** The agent works out plan amounts itself. It got them right in
  testing, but production would calculate them in code and give the agent the numbers.
