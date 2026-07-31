// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself
// a test that these values suffice. loadEnv is otherwise pure over its source.

import assert from 'node:assert/strict';
import test from 'node:test';

const BASE: Record<string, string> = {
  EMBERKIN_DATABASE_URL: 'postgres://emberkin:emberkin@127.0.0.1:5432/emberkin',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  OUTBOX_SIGNING_SECRET: 'a-real-secret-of-sufficient-length-000',
  LEDGER_URL: 'http://ledger',
  BILLING_URL: 'http://billing',
  WORLDS_URL: 'http://worlds',
  EMBERKIN_SERVICE_TOKEN: 'another-real-token-of-good-length-0000',
};
for (const [key, value] of Object.entries(BASE)) process.env[key] = value;

const { EnvError, loadEnv } = await import('./env.ts');

test('env: a valid environment loads', () => {
  const env = loadEnv(BASE, 'host-1');
  assert.equal(env.port, 4100);
  assert.equal(env.databaseUrl, BASE.EMBERKIN_DATABASE_URL);
  assert.equal(env.seasonRewardBudgetShards, 100_000n);
  assert.equal(env.instanceId, 'host-1');
});

test('env: a missing required variable names itself', () => {
  const missing = { ...BASE } as Record<string, string | undefined>;
  delete missing.EMBERKIN_DATABASE_URL;
  assert.throws(() => loadEnv(missing), (err) => err instanceof EnvError && /EMBERKIN_DATABASE_URL/.test(err.message));
});

test('env: a CHANGE_ME placeholder secret is refused', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'CHANGE_ME' }),
    (err) => err instanceof EnvError && /placeholder/.test(err.message),
  );
});

test('env: a short secret is refused (entropy proxy)', () => {
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: 'short' }), EnvError);
});

test('env: a non-positive reward budget is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_SHARDS: '0' }), EnvError);
});

test('env: the budget is read as a bigint, never a float', () => {
  const env = loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_SHARDS: '9007199254740993' });
  assert.equal(env.seasonRewardBudgetShards, 9007199254740993n);
});
