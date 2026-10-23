# Email to Atlas Recovery's COO

**Subject:** Account-number lookup is ready (plus one question)

Hi [COO's name],

Hope you're doing well. I'm happy to share that the account-number lookup your team asked for is ready: our AI agent can now look up Atlas accounts by account number, not just by phone number. That helps most when a debtor calls in from a phone number we don't have on file, or when several accounts share one phone number.

**How it works**
- You keep uploading your inventory file (the CSV) as you do today. Each time, we check every row and load the accounts into the system the agent uses.
- During a call, the agent looks up the account by its number and gets the debtor's name, balance and status.
- It discusses payment only after verifying the caller's identity, and only on accounts marked "Active". Balances are quoted "as of" your latest upload, so the fresher the file, the more accurate the call.

**What happens to each file**
- Each file needs six columns: account number, debtor name, phone number, balance, status and client name.
- A row with a problem (a missing account number, a balance that isn't a valid amount or is negative, or an account number listed more than once) is skipped, and the rest of the file loads. We send a summary of every skipped row and why, so your team can fix it at the source. If that account is already on file, we keep its previous details but flag it as needing review, and the agent won't discuss payment on it until a corrected row arrives.
- If the whole file looks wrong (a missing column, the wrong format, or more than 1 in 5 rows with problems), we load nothing and tell you why, so a broken export never touches your existing data.

Fixing any of these is simple: correct the file and upload it again. That's always safe, and each corrected row clears its flag automatically.

**What we need from your team**
Please forward the short checklist at the bottom of this email to whoever prepares the file. It covers the most common reasons a row gets skipped. Also, let me know who should receive the upload summaries, so skipped rows reach the person who can fix them.

**One question for you**
How do you mark accounts we shouldn't collect on, such as disputes, bankruptcies, do-not-call requests or attorney representation? Right now the agent discusses payment only on accounts marked "Active", and we read only the six columns above. If other statuses are fine to collect on, or you track any of this (or anything else the agent should know) in other columns, let us know and we'll add it.

The easiest way to see it in action is with real data: send over a recent export and we'll do a test run and share the summary, so you can see exactly how your accounts come through. And if it would help, I'm happy to walk you or your team through any of this on a quick call.

Best,
Varun Mehrotra
Forward Deployed Engineer, CollectWise

---

**File checklist (for whoever prepares the upload)**
1. Save the file as **CSV UTF-8**. Other formats garble accented names (é, ñ), so a file in another format that contains them will be refused.
2. Keep leading zeros in account numbers. If your system exports the CSV directly, upload that file as is, without opening it in Excel: re-saving it in Excel strips them (`00123` becomes `123`, a different account). If you build the file in Excel instead, format the account-number column as Text first, then use File > Save As > "CSV UTF-8".
3. Use these six column headings: `account_number`, `debtor_name`, `phone_number`, `balance`, `status`, `client_name`. Column order and capitalization don't matter.
4. List each account number only once per file. Account numbers may contain letters, digits, spaces and dashes; a row with anything else (such as `/` or `.`) is skipped. Spaces, dashes and capitalization are ignored, so `AB-123` and `ab123` count as the same account.
5. Fill in every column on every row. Balances can be written like `1250.50` or `$1,250.50` (never negative), and phone numbers in any common US format.
6. When an account closes or is paid off, keep it in the file with its new status (for example `Closed`) rather than removing it. An account that's left out of a file stays as it was, so a paid-off account that's simply dropped would still show as Active and the agent could still ask for payment. If your export can't include closed accounts, let us know.
7. Upload soon after exporting, since the agent quotes balances as of the upload. Never upload an older export after a newer one: its balances would replace the current ones.
8. After each upload, check the summary we send, correct any skipped rows, and upload the file again.
