import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ingestFile, IngestAbortedError } from '../src/ingest.js';

const HEADER = 'account_number,debtor_name,phone_number,balance,status,client_name';
let dir;
let dbPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ingest-'));
  dbPath = path.join(dir, 'test.db');
});

function writeCsv(name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function getAccount(accountNumber) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(accountNumber);
  } finally {
    db.close();
  }
}

function goodRows(count, startAt = 1) {
  return Array.from({ length: count }, (_, i) =>
    `${1000 + startAt + i},Person ${i},214-555-${String(1000 + i).slice(-4)},100.00,Active,Alpha Bank`);
}

test('inserts new accounts, then updates them on re-upload without touching created_at', () => {
  ingestFile(writeCsv('a.csv', [HEADER, '1001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank']), { dbPath });
  const first = getAccount('1001');

  const s = ingestFile(writeCsv('b.csv', [HEADER, '1001,Ann Lee,214-555-0101,40.00,Closed,Alpha Bank']), { dbPath });
  const second = getAccount('1001');

  assert.equal(s.inserted, 0);
  assert.equal(s.updated, 1);
  assert.equal(second.balance_cents, 4000);
  assert.equal(second.status, 'Closed');
  assert.equal(second.created_at, first.created_at);
  assert.ok(fs.existsSync(`${dbPath}.bak`), 'backup taken before second upload');
});

test('a rejected row keeps the existing record but holds it for review', () => {
  ingestFile(writeCsv('a.csv', [HEADER, '1001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank']), { dbPath });
  // A dispute arrives on a row with a bad phone number, so it can't be applied.
  const s = ingestFile(writeCsv('b.csv', [
    HEADER,
    '1001,Ann Lee,555-0101,40.00,Disputed,Alpha Bank',
    ...goodRows(9, 100),
  ]), { dbPath });

  assert.equal(s.rejected.length, 1);
  assert.equal(s.heldForReview, 1);
  const account = getAccount('1001');
  assert.equal(account.balance_cents, 10000);
  assert.equal(account.status, 'Active');
  assert.equal(account.needs_review, 1);
});

test('the next valid row for a held account lifts the hold', () => {
  ingestFile(writeCsv('a.csv', [HEADER, '1001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank']), { dbPath });
  ingestFile(writeCsv('b.csv', [HEADER, '1001,Ann Lee,555-0101,40.00,Disputed,Alpha Bank', ...goodRows(9, 100)]),
    { dbPath });
  ingestFile(writeCsv('c.csv', [HEADER, '1001,Ann Lee,214-555-0101,40.00,Disputed,Alpha Bank']), { dbPath });

  const account = getAccount('1001');
  assert.equal(account.needs_review, 0);
  assert.equal(account.status, 'Disputed');
});

test('accounts missing from a later upload are kept', () => {
  ingestFile(writeCsv('a.csv', [HEADER, ...goodRows(2)]), { dbPath });
  ingestFile(writeCsv('b.csv', [HEADER, ...goodRows(1)]), { dbPath });
  assert.ok(getAccount('1002'));
});

test('duplicate account numbers in one file are all rejected; an existing account is held', () => {
  ingestFile(writeCsv('a.csv', [HEADER, '2001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank']), { dbPath });
  const s = ingestFile(writeCsv('b.csv', [
    HEADER,
    '2001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank',
    '2001,Ann Lee,214-555-0101,90.00,Active,Alpha Bank',
    '2002,Bo Kim,214-555-0102,50.00,Active,Alpha Bank',
    '2002,Bo Kim,214-555-0102,50.00,Active,Alpha Bank',
    ...goodRows(16),
  ]), { dbPath });

  // Already on file: data unchanged, only the hold is set.
  assert.equal(getAccount('2001').balance_cents, 10000);
  assert.equal(getAccount('2001').needs_review, 1);
  // Not on file: nothing is added.
  assert.equal(getAccount('2002'), undefined);
  assert.equal(s.heldForReview, 1);
  assert.match(s.rejected.find((r) => r.accountNumber === '2001').reasons[0], /conflicting/);
  assert.match(s.rejected.find((r) => r.accountNumber === '2002').reasons[0], /identical/);
});

test('statuses other than Active and Closed are stored and counted in the summary', () => {
  ingestFile(writeCsv('a.csv', [HEADER, '1001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank']), { dbPath });
  const s = ingestFile(writeCsv('b.csv', [
    HEADER,
    '1001,Ann Lee,214-555-0101,100.00,Disputed,Alpha Bank',
    '1002,Bo Kim,214-555-0102,50.00,active,Alpha Bank',
  ]), { dbPath });

  // A disputed account must not stay Active from an earlier upload.
  assert.equal(getAccount('1001').status, 'Disputed');
  assert.deepEqual(s.statusCounts, { Disputed: 1, Active: 1 });
});

test('header names are matched case-insensitively and a BOM is ignored', () => {
  const p = path.join(dir, 'bom.csv');
  fs.writeFileSync(p, '﻿Account_Number,Debtor_Name,Phone_Number,Balance,STATUS,Client_Name\n' +
    '1001,Ann Lee,214-555-0101,100.00,Active,Alpha Bank\n');
  assert.equal(ingestFile(p, { dbPath }).inserted, 1);
});

test('a missing required column aborts the whole file', () => {
  const p = writeCsv('a.csv', ['account_number,debtor_name,phone_number,status,client_name',
    '1001,Ann Lee,214-555-0101,Active,Alpha Bank']);
  assert.throws(() => ingestFile(p, { dbPath }), (err) =>
    err instanceof IngestAbortedError && /balance/.test(err.message));
  assert.equal(fs.existsSync(dbPath), false, 'nothing written');
});

test('too many bad rows aborts the whole file and writes nothing', () => {
  ingestFile(writeCsv('a.csv', [HEADER, ...goodRows(2)]), { dbPath });
  const p = writeCsv('b.csv', [
    HEADER,
    '1001,Person 0,214-555-1000,5.00,Active,Alpha Bank', // valid, would update...
    '1002,Person 1,214-555-1001,oops,Active,Alpha Bank', // rejected, would hold...
    ...Array.from({ length: 3 }, (_, i) => `${3000 + i},X,214-555-0101,oops,Active,Alpha Bank`),
  ]);
  assert.throws(() => ingestFile(p, { dbPath }), IngestAbortedError);
  // ...but the file was aborted.
  assert.equal(getAccount('1001').balance_cents, 10000);
  assert.equal(getAccount('1002').needs_review, 0);
});

test('a file not saved as UTF-8 aborts; accented names in UTF-8 are kept', () => {
  // Windows-1252, Excel's plain "CSV" format: é and ñ are the single bytes 0xE9 and 0xF1.
  const cp1252 = path.join(dir, 'cp1252.csv');
  fs.writeFileSync(cp1252, Buffer.from(`${HEADER}\n1001,Jos\xe9 Pe\xf1a,214-555-0101,10.00,Active,Alpha Bank\n`, 'latin1'));
  assert.throws(() => ingestFile(cp1252, { dbPath }), (err) =>
    err instanceof IngestAbortedError && /UTF-8/.test(err.message));
  assert.equal(fs.existsSync(dbPath), false, 'nothing written');

  ingestFile(writeCsv('utf8.csv', [HEADER, '1001,José Peña,214-555-0101,10.00,Active,Alpha Bank']), { dbPath });
  assert.equal(getAccount('1001').debtor_name, 'José Peña');
});

test('a file with only a header aborts', () => {
  assert.throws(() => ingestFile(writeCsv('a.csv', [HEADER]), { dbPath }), IngestAbortedError);
});
