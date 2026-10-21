-- One row per debtor account. account_number is the business key used for
-- lookups and for upserts on repeat uploads.
--
-- The CHECK constraints repeat rules enforced in src/validate.js on purpose:
-- if a bug ever lets a bad value past validation, the database still refuses it.

CREATE TABLE IF NOT EXISTS accounts (
  account_number  TEXT PRIMARY KEY,                         -- normalized: uppercase, no spaces/dashes
  debtor_name     TEXT NOT NULL,
  phone_number    TEXT NOT NULL,                            -- US number in E.164, e.g. +12145550123
  balance_cents   INTEGER NOT NULL CHECK (balance_cents >= 0),
  status          TEXT NOT NULL CHECK (status <> ''),       -- Active, Closed, or as sent (e.g. Disputed)
  client_name     TEXT NOT NULL,
  -- 1 when a later upload had a rejected row for this account, so the data here may
  -- be out of date. The agent must not act on a held account. Cleared by the next
  -- valid row for it.
  needs_review    INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  created_at      TEXT NOT NULL,                            -- set once, on first insert (UTC ISO-8601)
  updated_at      TEXT NOT NULL                             -- refreshed on every upload containing the account
);

-- Phone is the existing lookup path. Not UNIQUE: one person can hold several
-- accounts, and household members can share a number.
CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts (phone_number);
