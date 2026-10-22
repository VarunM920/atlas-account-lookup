// Account lookup API for the voice agent.
//
//   npm start                          # port 3000, or PORT
//   curl localhost:3000/accounts/10024500
//
// When API_KEY is set, /accounts requires it in the x-api-key header. Unset (local
// runs, tests), the API is open and a warning is logged at startup.
//
// Every response is JSON, including errors and unknown routes, so the agent can
// branch on a stable { error, message } body instead of an HTML error page.

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import { parseAccountNumber } from './validate.js';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function sendError(res, status, error, message) {
  res.status(status).json({ error, message });
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

function requireApiKey(apiKey) {
  const expected = sha256(apiKey);
  return (req, res, next) => {
    const given = req.get('x-api-key');
    // Compare fixed-length digests in constant time, so response timing doesn't
    // reveal how much of a guessed key was right.
    if (given && crypto.timingSafeEqual(sha256(given), expected)) return next();
    sendError(res, 401, 'unauthorized', 'Missing or invalid API key. Send it in the x-api-key header.');
  };
}

function toResponse(row) {
  // A held account's data may be out of date (see README, "Rejected rows"), so
  // the agent gets enough to identify the caller but nothing it could quote.
  const held = row.needs_review === 1;
  return {
    account_number: row.account_number,
    debtor_name: row.debtor_name,
    phone_number: row.phone_number,
    balance: held ? null : row.balance_cents / 100,
    balance_formatted: held ? null : usd.format(row.balance_cents / 100),
    balance_as_of: held ? null : row.updated_at,
    status: held ? null : row.status,
    client_name: row.client_name,
    needs_review: held,
  };
}

export function createApp({ db, apiKey }) {
  const app = express();
  app.disable('x-powered-by');
  // Account data only; /health and unknown routes stay open.
  if (apiKey) app.use('/accounts', requireApiKey(apiKey));

  const ping = db.prepare('SELECT 1');
  const findAccount = db.prepare('SELECT * FROM accounts WHERE account_number = ?');

  app.get('/health', (req, res) => {
    ping.get(); // throws, and so returns 500, if the database can't be read
    res.json({ ok: true });
  });

  // Same rule as ingestion: parseAccountNumber() normalizes with
  // normalizeAccountNumber(), so "ab-1234 56" finds AB123456.
  app.get('/accounts/:accountNumber', (req, res) => {
    const { value: accountNumber, error } = parseAccountNumber(req.params.accountNumber);
    if (error) {
      return sendError(res, 400, 'invalid_account_number',
        'The account number is empty or contains characters other than letters and digits.');
    }

    const row = findAccount.get(accountNumber);
    if (!row) {
      return sendError(res, 404, 'account_not_found', `No account found with number ${accountNumber}.`);
    }
    res.json(toResponse(row));
  });

  // "/accounts/" with nothing after it: an empty account number, not a missing route.
  app.get('/accounts', (req, res) => {
    sendError(res, 400, 'invalid_account_number', 'No account number was provided.');
  });

  app.use((req, res) => {
    sendError(res, 404, 'not_found', `No route for ${req.method} ${req.path}.`);
  });

  // Express gives client errors, such as a malformed %-escape in the URL, a 4xx status.
  app.use((err, req, res, next) => {
    if (err.status >= 400 && err.status < 500) {
      return sendError(res, 400, 'bad_request', 'The request could not be understood.');
    }
    console.error(err);
    sendError(res, 500, 'internal_error', 'The account could not be looked up. Please try again.');
  });

  return app;
}

function main() {
  const port = Number(process.env.PORT) || 3000;
  const apiKey = process.env.API_KEY;
  const db = openDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM accounts').get();
  createApp({ db, apiKey }).listen(port, () => {
    console.log(`Account lookup API listening on port ${port}`);
    console.log(`Serving ${count} account(s) from ${DEFAULT_DB_PATH}`);
    if (count === 0) console.log('The database is empty. Load a CSV first: npm run ingest -- <file>');
    if (apiKey) {
      console.log('API key required (x-api-key header).');
    } else {
      console.warn('WARNING: API_KEY is not set, so account data is open to anyone who can reach ' +
        'this server. Fine locally; set API_KEY on any deployed instance.');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
