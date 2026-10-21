// Pure parsing/validation helpers shared by the ingest script and the API.
// Each field parser returns { value } on success or { error } with a
// human-readable reason that ends up in the ingest summary.

export const REQUIRED_COLUMNS = [
  'account_number',
  'debtor_name',
  'phone_number',
  'balance',
  'status',
  'client_name',
];

/**
 * Canonical form of an account number: uppercase, with spaces and dashes removed.
 * Used both when storing and when looking up, so "ab-1234 56" matches "AB123456".
 * This matters for the voice agent, which hears account numbers read aloud.
 */
export function normalizeAccountNumber(raw) {
  return String(raw ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
}

export function parseAccountNumber(raw) {
  const value = normalizeAccountNumber(raw);
  if (!value) return { error: 'missing account_number' };
  if (!/^[A-Z0-9]+$/.test(value)) {
    return { error: `invalid account_number "${String(raw).trim()}" (letters and digits only)` };
  }
  return { value };
}

/** Balance → integer cents. Allows "$" and thousands commas; max 2 decimals; no negatives. */
export function parseBalanceCents(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return { error: 'missing balance' };

  // Commas only as thousands separators: a decimal comma ("12,50") would
  // otherwise be read as 1250.
  const noDollar = original.replace(/\$/g, '');
  if (noDollar.includes(',') && !/^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(noDollar)) {
    return { error: `invalid balance "${original}" (commas allowed only as thousands separators)` };
  }

  const cleaned = noDollar.replace(/,/g, '');
  if (/^-\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { error: `negative balance (${original}); may indicate an overpayment, needs manual review` };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { error: `invalid balance "${original}" (expected a number with at most 2 decimals)` };
  }

  // Parse the string directly rather than parseFloat(x) * 100, which drifts
  // (1.15 * 100 === 114.99999999999999).
  const [whole, frac = ''] = cleaned.split('.');
  return { value: Number(whole) * 100 + Number(frac.padEnd(2, '0')) };
}

/** US phone → E.164. Accepts 10 digits, or 11 digits starting with 1, in any common formatting. */
export function parsePhone(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return { error: 'missing phone_number' };

  // Only digits and common formatting characters. Rejects letters,
  // so extensions like "x45" are refused rather than silently merged in.
  if (!/^\+?[\d\s().-]+$/.test(original)) {
    return { error: `invalid phone_number "${original}" (expected 10-digit US number)` };
  }

  const digits = original.replace(/\D/g, '');
  if (digits.length === 10) return { value: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith('1')) return { value: `+${digits}` };
  return { error: `invalid phone_number "${original}" (expected 10-digit US number)` };
}

/**
 * Status: any non-empty value. Active and Closed are matched case-insensitively;
 * anything else (Disputed, Bankruptcy, ...) is stored as given. Only Active is
 * collectible, so an unknown or misspelled status fails safe (see README).
 */
export function parseStatus(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return { error: 'missing status' };
  const lower = original.toLowerCase();
  if (lower === 'active') return { value: 'Active' };
  if (lower === 'closed') return { value: 'Closed' };
  return { value: original };
}

function parseRequiredText(raw, field) {
  const value = String(raw ?? '').trim();
  return value ? { value } : { error: `missing ${field}` };
}

/**
 * Validate one CSV row (keys already normalized to lowercase column names).
 * Collects every problem rather than stopping at the first, so Atlas can fix
 * a row in one pass.
 */
export function validateRow(raw) {
  const results = {
    account_number: parseAccountNumber(raw.account_number),
    debtor_name: parseRequiredText(raw.debtor_name, 'debtor_name'),
    phone_number: parsePhone(raw.phone_number),
    balance_cents: parseBalanceCents(raw.balance),
    status: parseStatus(raw.status),
    client_name: parseRequiredText(raw.client_name, 'client_name'),
  };

  const errors = Object.values(results).filter((r) => r.error).map((r) => r.error);
  if (errors.length) return { ok: false, errors };

  const record = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.value]));
  return { ok: true, record };
}

/** Normalize a CSV header cell: strip a UTF-8 BOM, trim, lowercase. */
export function normalizeHeader(name) {
  return String(name).replace(/^﻿/, '').trim().toLowerCase();
}
