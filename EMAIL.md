# Email to Atlas Recovery's COO

**Subject:** Account-number lookup is ready (plus one question)

Hi [COO's name],

Hope you're doing well. I'm happy to share that the account-number lookup your team asked for is ready: our AI agent can now look up Atlas accounts by account number, not just by phone number. That helps most when a debtor calls in from a phone number we don't have on file, or when several accounts share one phone number.

**How it works**
- You keep uploading your inventory file (the CSV) as you do today. Each time, we check every row and load the accounts into the system the agent uses.
- During a call, the agent looks up the account by its number and gets the debtor's name, balance and status.
- It discusses payment only after confirming it's speaking with the right person, and only on accounts marked "Active". Balances are quoted "as of" your latest upload, so the fresher the file, the more accurate the call.

**What happens to each file**
- Each file needs six columns: account number, debtor name, phone number, balance, status and client name.
- If a row has a problem, such as a missing account number, a balance that isn't a valid amount, or a negative balance, we skip that row, load the rest, and send you a summary listing every skipped row and the reason, so your team can fix it at the source.
- If a skipped row belongs to an account we already have, we keep its previous details but flag it as needing review: the agent won't discuss payment on it until a corrected row arrives.
- If the same account number appears more than once in a file, we skip every copy, since we can't tell which one is right. An account we already have is flagged the same way.
- If the whole file looks wrong (a missing column, the wrong format, or more than 1 in 5 rows with problems), we load nothing and tell you why. A bad export can never overwrite good data.

Fixing any of these is simple: correct the file and upload it again. Re-uploading is always safe, and corrected rows clear their flags automatically.

**What we need from your team**
I've put a short checklist at the bottom of this email that you can pass along to whoever prepares the file. It covers the most common reasons a row gets skipped.

**One question for you**
How do you mark accounts we shouldn't collect on, such as disputes, bankruptcies, do-not-call requests or attorney representation? Right now the agent discusses payment only on accounts marked "Active", and we read only the six columns above. If other statuses are fine to collect on, or you track any of this (or anything else the agent should know) in other columns, let us know and we'll add it.

The easiest way to see it in action is with real data: send over a recent export and we'll do a test run and share the summary, so you can see exactly how your accounts come through. And if it would help, I'm happy to walk you or your team through any of this on a quick call.

Best,
Varun Mehrotra
Forward Deployed Engineer, CollectWise

---

**File checklist (for whoever prepares the upload)**
1. Save the file as **CSV UTF-8** (in Excel: File > Save As > "CSV UTF-8"). Other formats garble names with accents, so a file like that is refused.
2. Use these six column headings: `account_number`, `debtor_name`, `phone_number`, `balance`, `status`, `client_name`. Column order and capitalization don't matter.
3. List each account number only once per file.
4. Keep leading zeros in account numbers. If your system exports the CSV directly, upload it as is: opening and re-saving it in Excel turns `00123` into `123`, which is a different account. If you build the file in Excel, format the account number column as Text first.
5. Fill in every column on every row. Balances can be written like `1250.50` or `$1,250.50` (never negative), and phone numbers in any common US format.
6. When an account closes or is paid off, keep it in the file with its new status (for example `Closed`) rather than removing it. An account that's left out of a file stays as it was. If your export can't include closed accounts, let us know.
7. Upload soon after exporting, since the agent quotes balances as of the upload.
8. After each upload, check the summary we send, correct any skipped rows, and upload the file again.
