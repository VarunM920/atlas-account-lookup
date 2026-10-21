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
});

test('bad balances are rejected', () => {
  for (const bad of ['', 'N/A', '12.345', '1.2.3', 'abc']) {
    assert.ok(parseBalanceCents(bad).error, `expected "${bad}" to be rejected`);
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

test('status is Active or Closed, case-insensitive', () => {
  assert.deepEqual(parseStatus(' ACTIVE '), { value: 'Active' });
  assert.deepEqual(parseStatus('closed'), { value: 'Closed' });
  assert.ok(parseStatus('Paid').error);
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
