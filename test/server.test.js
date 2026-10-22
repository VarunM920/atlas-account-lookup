import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestFile } from '../src/ingest.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

const HEADER = 'account_number,debtor_name,phone_number,balance,status,client_name';
let dir;
let db;
let server;
let baseUrl;

function writeCsv(name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

async function listen(app) {
  const s = app.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return s;
}

function close(s) {
  s.closeAllConnections(); // fetch keeps connections alive, which would hold close() open
  s.close();
}

/** GET a path; every response must be JSON, errors included. */
async function get(urlPath, { base = baseUrl, method = 'GET' } = {}) {
  const res = await fetch(base + urlPath, { method });
  assert.match(res.headers.get('content-type'), /^application\/json/, `${method} ${urlPath} returned non-JSON`);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-api-'));
  const dbPath = path.join(dir, 'test.db');
  // Loaded through the real ingestion code, so lookups see data exactly as stored.
  ingestFile(writeCsv('a.csv', [
    HEADER,
    'ab-1234,Ann Lee,(214) 555-0101,"$1,250.50",Active,Alpha Bank',
    '00031822,Ruth Abernathy,214-555-0102,0,Closed,Alpha Bank',
    '5001,Hal Moss,214-555-0103,300.00,Active,Alpha Bank',
  ]), { dbPath });
  // A later upload with a bad row for 5001 puts it on hold.
  ingestFile(writeCsv('b.csv', [HEADER, '5001,Hal Moss,214-555-0103,N/A,Disputed,Alpha Bank']),
    { dbPath, failureThreshold: 1 });

  db = openDb(dbPath);
  server = await listen(createApp({ db }));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  close(server);
  db.close();
});

test('returns a found account as JSON', async () => {
  const { status, body } = await get('/accounts/AB1234');
  assert.equal(status, 200);
  const { balance_as_of: asOf, ...rest } = body;
  assert.deepEqual(rest, {
    account_number: 'AB1234',
    debtor_name: 'Ann Lee',
    phone_number: '+12145550101',
    balance: 1250.5,
    balance_formatted: '$1,250.50',
    status: 'Active',
    client_name: 'Alpha Bank',
    needs_review: false,
  });
  assert.ok(!Number.isNaN(Date.parse(asOf)), 'balance_as_of is the upload timestamp');
});

test('normalizes the account number the same way ingestion does', async () => {
  for (const input of ['ab1234', 'AB-1234', 'ab-12 34', '%20AB%201234%20']) {
    const { status, body } = await get(`/accounts/${input}`);
    assert.equal(status, 200, input);
    assert.equal(body.account_number, 'AB1234', input);
  }
});

test('returns 404 account_not_found for an unknown account', async () => {
  const { status, body } = await get('/accounts/99999999');
  assert.equal(status, 404);
  assert.equal(body.error, 'account_not_found');
  assert.match(body.message, /99999999/);

  // Leading zeros are part of the number: 00031822 exists, 31822 doesn't.
  assert.equal((await get('/accounts/31822')).status, 404);
});

test('returns 400 invalid_account_number for empty or malformed input', async () => {
  for (const input of ['%20', '---', 'AB%23123', '12.34', '']) {
    const { status, body } = await get(`/accounts/${input}`);
    assert.equal(status, 400, `"${input}"`);
    assert.equal(body.error, 'invalid_account_number', `"${input}"`);
  }
});

test('returns 400 for a malformed URL escape instead of crashing', async () => {
  const { status, body } = await get('/accounts/%E0%A4%A');
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_request');
});

test('returns closed accounts normally, not as 404', async () => {
  const { status, body } = await get('/accounts/00031822');
  assert.equal(status, 200);
  assert.equal(body.status, 'Closed');
  assert.equal(body.balance, 0);
  assert.equal(body.balance_formatted, '$0.00');
});

test('withholds balance and status for an account held for review', async () => {
  const { status, body } = await get('/accounts/5001');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    account_number: '5001',
    debtor_name: 'Hal Moss',
    phone_number: '+12145550103',
    balance: null,
    balance_formatted: null,
    balance_as_of: null,
    status: null,
    client_name: 'Alpha Bank',
    needs_review: true,
  });
});

test('unknown routes and methods return a JSON 404', async () => {
  assert.deepEqual((await get('/nope')).body.error, 'not_found');
  const post = await get('/accounts/AB1234', { method: 'POST' });
  assert.equal(post.status, 404);
  assert.equal(post.body.error, 'not_found');
});

test('health check reports ok', async () => {
  assert.deepEqual(await get('/health'), { status: 200, body: { ok: true } });
});

test('an unexpected failure returns a JSON 500 without internals', async (t) => {
  t.mock.method(console, 'error', () => {}); // the handler logs the error; keep test output clean
  const brokenDb = openDb(path.join(dir, 'broken.db'));
  const brokenServer = await listen(createApp({ db: brokenDb }));
  brokenDb.close(); // every query now throws
  try {
    const { status, body } = await get('/accounts/AB1234', { base: `http://127.0.0.1:${brokenServer.address().port}` });
    assert.equal(status, 500);
    assert.deepEqual(Object.keys(body), ['error', 'message']);
    assert.equal(body.error, 'internal_error');
  } finally {
    close(brokenServer);
  }
});
