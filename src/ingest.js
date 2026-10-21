// CSV ingestion for Atlas Recovery inventory files.
//
//   npm run ingest                         # reads ./atlas_inventory.csv
//   npm run ingest -- path/to/file.csv     # any other file
//
// Rules (see README for the reasoning):
//   - File-level problems (missing required column, no data rows, too many bad
//     rows) abort the whole file. Nothing is written.
//   - Row-level problems reject that row only. The account's existing data is
//     kept, and the reason is listed in the summary.
//   - An account_number appearing more than once in a file is ambiguous, so
//     every occurrence is rejected for manual review.
//   - Valid rows are upserted in a single transaction: new accounts inserted,
//     existing ones overwritten. Nothing is ever deleted.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse/sync';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import {
  REQUIRED_COLUMNS,
  normalizeAccountNumber,
  normalizeHeader,
  validateRow,
} from './validate.js';

export const DEFAULT_FAILURE_THRESHOLD = 0.2;

export class IngestAbortedError extends Error {}

/** Parse the CSV into { header, rows: [{ rowNum, raw }] }. */
function readCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new IngestAbortedError(`File not found: ${csvPath}`);
  }

  let header = [];
  const records = parse(fs.readFileSync(csvPath), {
    bom: true,
    columns: (names) => {
      // "Account Number" and "account_number" both become account_number.
      header = names.map((n) => normalizeHeader(n).replace(/\s+/g, '_'));
      return header;
    },
    skip_empty_lines: true,
    relax_column_count: true, // short rows yield undefined fields, caught by validation
    info: true,
  });

  return {
    header,
    rows: records.map(({ record, info }) => ({ rowNum: info.lines, raw: record })),
  };
}

/** Group rows by account number and return the groups that appear more than once. */
function findDuplicates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizeAccountNumber(row.raw.account_number);
    if (!key) continue; // missing account_number is reported by row validation
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].filter(([, group]) => group.length > 1);
}

function rawSignature(raw) {
  return JSON.stringify(REQUIRED_COLUMNS.map((c) => String(raw[c] ?? '').trim()));
}

export function ingestFile(csvPath, {
  dbPath = DEFAULT_DB_PATH,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
} = {}) {
  const { header, rows } = readCsv(csvPath);

  // 1. File-level checks.
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length) {
    throw new IngestAbortedError(
      `Missing required column(s): ${missingColumns.join(', ')}. Found: ${header.join(', ') || '(none)'}`
    );
  }
  if (rows.length === 0) {
    throw new IngestAbortedError('File has a header but no data rows.');
  }

  // 2. Duplicate account numbers within the file: reject every occurrence.
  const rejected = [];
  const duplicateRowNums = new Set();
  for (const [accountNumber, group] of findDuplicates(rows)) {
    const rowNums = group.map((r) => r.rowNum);
    rowNums.forEach((n) => duplicateRowNums.add(n));
    const identical = new Set(group.map((r) => rawSignature(r.raw))).size === 1;
    rejected.push({
      rowNums,
      accountNumber,
      reasons: [
        identical
          ? `appears ${group.length} times, identical rows; likely export duplication`
          : `appears ${group.length} times with conflicting values; needs manual review`,
      ],
    });
  }

  // 3. Row-level validation for everything else.
  const valid = [];
  for (const row of rows) {
    if (duplicateRowNums.has(row.rowNum)) continue;
    const result = validateRow(row.raw);
    if (result.ok) {
      valid.push(result.record);
    } else {
      rejected.push({
        rowNums: [row.rowNum],
        accountNumber: normalizeAccountNumber(row.raw.account_number) || null,
        reasons: result.errors,
      });
    }
  }

  // 4. Too many bad rows usually means a broken export, not a few typos.
  const rejectedRowCount = rows.length - valid.length;
  const rejectedRate = rejectedRowCount / rows.length;
  if (rejectedRate > failureThreshold) {
    const err = new IngestAbortedError(
      `${rejectedRowCount} of ${rows.length} rows (${(rejectedRate * 100).toFixed(1)}%) failed validation, ` +
      `above the ${(failureThreshold * 100).toFixed(0)}% threshold. The file looks malformed, so nothing was written.`
    );
    err.rejected = rejected;
    throw err;
  }

  // 5. Keep one copy of the database as it was before this upload.
  let backupPath = null;
  if (fs.existsSync(dbPath)) {
    backupPath = `${dbPath}.bak`;
    fs.copyFileSync(dbPath, backupPath);
  }

  // 6. Upsert all valid rows in one transaction: all or nothing.
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const exists = db.prepare('SELECT 1 FROM accounts WHERE account_number = ?');
  const upsert = db.prepare(`
    INSERT INTO accounts
      (account_number, debtor_name, phone_number, balance_cents, status, client_name, created_at, updated_at)
    VALUES
      (@account_number, @debtor_name, @phone_number, @balance_cents, @status, @client_name, @now, @now)
    ON CONFLICT (account_number) DO UPDATE SET
      debtor_name   = excluded.debtor_name,
      phone_number  = excluded.phone_number,
      balance_cents = excluded.balance_cents,
      status        = excluded.status,
      client_name   = excluded.client_name,
      updated_at    = excluded.updated_at
  `);

  let inserted = 0;
  let updated = 0;
  try {
    db.transaction(() => {
      for (const record of valid) {
        if (exists.get(record.account_number)) updated++;
        else inserted++;
        upsert.run({ ...record, now });
      }
    })();
  } finally {
    db.close();
  }

  rejected.sort((a, b) => a.rowNums[0] - b.rowNums[0]);
  return { rowsRead: rows.length, inserted, updated, rejected, dbPath, backupPath };
}

function formatRejected({ rowNums, accountNumber, reasons }) {
  const where = rowNums.length > 1 ? `rows ${rowNums.join(', ')}` : `row ${rowNums[0]}`;
  const account = accountNumber ? ` (account ${accountNumber})` : '';
  return `  ${where}${account}: rejected: ${reasons.join('; ')}`;
}

function main() {
  const csvPath = path.resolve(process.argv[2] || 'atlas_inventory.csv');
  const threshold = process.env.INGEST_FAILURE_THRESHOLD
    ? Number(process.env.INGEST_FAILURE_THRESHOLD)
    : DEFAULT_FAILURE_THRESHOLD;

  try {
    const s = ingestFile(csvPath, { failureThreshold: threshold });
    console.log(`Ingested ${csvPath}`);
    console.log(`  Rows read: ${s.rowsRead}`);
    console.log(`  Inserted:  ${s.inserted}`);
    console.log(`  Updated:   ${s.updated}`);
    console.log(`  Rejected:  ${s.rowsRead - s.inserted - s.updated}`);
    if (s.rejected.length) {
      console.log('\nRejected rows (existing data for these accounts was left unchanged):');
      s.rejected.forEach((r) => console.log(formatRejected(r)));
    }
    console.log(`\nDatabase: ${s.dbPath}`);
    if (s.backupPath) console.log(`Previous version backed up to: ${s.backupPath}`);
  } catch (err) {
    if (!(err instanceof IngestAbortedError)) throw err;
    console.error(`Ingest aborted: ${err.message}`);
    if (err.rejected?.length) {
      console.error('\nProblems found:');
      err.rejected.forEach((r) => console.error(formatRejected(r)));
    }
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
