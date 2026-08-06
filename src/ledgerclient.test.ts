// The postings a reward is made of. No database and no ledger: these are pure functions, and the
// thing worth pinning is the ACCOUNT KEY and its TYPE, because the ledger keys an account on
// (subject, asset_code, purpose) and refuses an entry whose stated type disagrees with the row
// that already exists (ledger/src/accounts.ts, AccountConflictError).
//
// That refusal is not per-entry. It is every entry, from whichever service posted second, for as
// long as the disagreement stands — and it is invisible to every suite in the estate because each
// service tests against its own fake ledger. This file is the closest a single repository can get
// to catching it: it asserts what THIS service claims, in a form a reader can compare against the
// canonical table without running anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { engagementAccount } from '@cloudsforge/contracts-money';

import { rewardPostings, rewardIdempotencyKey } from './ledgerclient.ts';

test('reward: the debit side is engagement:emberkin / treasury / equity', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });
  const debit = postings.find((p) => p.direction === 'debit');
  assert.ok(debit, 'a reward must have a debit side');

  // Spelled by contracts-money so a second spelling cannot split the programme's ledger.
  assert.equal(debit.account.subject, engagementAccount('emberkin', 'SHARD').subject);
  assert.equal(debit.account.subject, 'engagement:emberkin');
  assert.equal(debit.account.purpose, 'treasury');

  // `equity` and not `expense`. The ledger's overdraft trigger exempts `clearing` and `suspense`
  // and NOT `equity`, so an unfunded engagement account refuses a reward instead of going
  // negative. The budget column is the cap; this balance is the funding.
  assert.equal(debit.account.type, 'equity');
});

test('reward: it does NOT touch (platform, SHARD, fees) — five services own that key as revenue', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });

  // The defect this asserts against, exactly: debiting (platform, SHARD, fees) as `expense` while
  // billing, market, mint, trade and wallet name the same key `revenue`. Reintroducing it turns
  // this red here, before it turns every entry red in production.
  for (const posting of postings) {
    const collides =
      posting.account.subject === 'platform' &&
      posting.account.purpose === 'fees' &&
      posting.account.type !== 'revenue';
    assert.equal(
      collides,
      false,
      `(platform, ${posting.account.assetCode}, fees) is revenue estate-wide; this posting claims ${posting.account.type}`,
    );
  }
});

test('reward: the credit side is the player, and the entry balances', () => {
  const postings = rewardPostings({ subject: 'user:alice', amount: 500n });
  const credit = postings.find((p) => p.direction === 'credit');
  assert.ok(credit);
  assert.equal(credit.account.subject, 'user:alice');
  assert.equal(credit.account.purpose, 'available');
  assert.equal(credit.account.type, 'liability');

  const debits = postings.filter((p) => p.direction === 'debit').reduce((a, p) => a + p.amount, 0n);
  const credits = postings.filter((p) => p.direction === 'credit').reduce((a, p) => a + p.amount, 0n);
  assert.equal(debits, credits);
  assert.equal(debits, 500n);

  // Every posting is SHARD, so "balances per asset" and "balances" are the same statement here.
  assert.deepEqual([...new Set(postings.map((p) => p.assetCode))], ['SHARD']);
});

test('reward: the idempotency key is derived from (season, user, reason)', () => {
  assert.equal(rewardIdempotencyKey('s1', 'u1', 'weekly'), 'emberkin:reward:s1:u1:weekly');
  assert.notEqual(rewardIdempotencyKey('s1', 'u1', 'weekly'), rewardIdempotencyKey('s1', 'u1', 'daily'));
});
