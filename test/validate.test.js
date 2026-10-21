import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccountNumber,
  parseAccountNumber,
  parseBalanceCents,
  parsePhone,
  parseStatus,
  validateRow,
} from '../src/validate.js';

test('account numbers normalize to uppercase with spaces and dashes removed', () => {
  assert.equal(normalizeAccountNumber(' ab-1234 56 '), 'AB123456');
  assert.equal(normalizeAccountNumber('00031822'), '00031822'); // leading zeros kept
  assert.deepEqual(parseAccountNumber(''), { error: 'missing account_number' });
  assert.ok(parseAccountNumber('AB#123').error);
});

test('balances parse to integer cents', () => {
  assert.deepEqual(parseBalanceCents('1250.50'), { value: 125050 });
  assert.deepEqual(parseBalanceCents('$1,250.50'), { value: 125050 });
  assert.deepEqual(parseBalanceCents('1250.5'), { value: 125050 });
  assert.deepEqual(parseBalanceCents('1250'), { value: 125000 });
  assert.deepEqual(parseBalanceCents('1.15'), { value: 115 }); // no float drift
  assert.deepEqual(parseBalanceCents('0'), { value: 0 });
  assert.deepEqual(parseBalanceCents('12,345,678.90'), { value: 1234567890 });
});

test('bad balances are rejected', () => {
  for (const bad of ['', 'N/A', '12.345', '1.2.3', 'abc']) {
    assert.ok(parseBalanceCents(bad).error, `expected "${bad}" to be rejected`);
  }
  // A decimal comma must not be misread: "12,50" is not 1250.
  for (const bad of ['12,50', '1,25', '1,250,5', '1.250,50', '1234,567']) {
    assert.match(parseBalanceCents(bad).error, /thousands separators/, bad);
  }
  assert.match(parseBalanceCents('-20.00').error, /negative balance.*manual review/);
});

test('US phone numbers normalize to E.164', () => {
  for (const input of ['(214) 555-0123', '214-555-0123', '214.555.0123', '2145550123',
    '+1 214 555 0123', '12145550123']) {
    assert.deepEqual(parsePhone(input), { value: '+12145550123' }, input);
  }
});

test('bad phone numbers are rejected', () => {
  for (const bad of ['', '555-0123', '214-555-0123 x45', '22145550123', 'call me']) {
    assert.ok(parsePhone(bad).error, `expected "${bad}" to be rejected`);
  }
});

test('status: Active and Closed are case-insensitive, other values are kept as given', () => {
  assert.deepEqual(parseStatus(' ACTIVE '), { value: 'Active' });
  assert.deepEqual(parseStatus('closed'), { value: 'Closed' });
  assert.deepEqual(parseStatus(' Disputed '), { value: 'Disputed' });
  assert.ok(parseStatus('').error);
});

test('validateRow reports every problem in a row, not just the first', () => {
  const result = validateRow({
    account_number: '123',
    debtor_name: '   ',
    phone_number: '214-555-0123',
    balance: 'N/A',
    status: 'Active',
    // client_name missing entirely (short row)
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
});
