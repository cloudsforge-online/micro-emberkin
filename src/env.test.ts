// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself
// a test that these values suffice. loadEnv is otherwise pure over its source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY SECRET FIXTURE IN THIS FILE USED TO BE A PLACEHOLDER THAT THE GUARD NOW REFUSES.
 *
 * `OUTBOX_SIGNING_SECRET` was `'a-real-secret-of-sufficient-length-000'`. Strip its punctuation and
 * it reads `arealsecretofsufficientlength000` — it contains `sufficientlength`, which is on
 * `@cloudsforge/secrets`' marker list precisely because somebody wrote it here. It is 37 typed
 * characters with hyphens in it, so it is not base64, not hex, and not a key. The test suite was
 * asserting that a placeholder was a valid signing key, which is why ninety-odd green tests sat
 * over the defect in micro-org #142 without one of them going red.
 *
 * A FIXTURE EXEMPT FROM THE RULE IT EXERCISES IS NOT A FIXTURE, IT IS A HOLE. So the key material
 * below is GENERATED per run, exactly as the runbook tells an operator to generate it.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
const generatedKey = (): string => randomBytes(48).toString('base64');

/**
 * A JWT-SHAPED token fixture. Not signed and not verifiable — `env.ts` matches the shape and
 * deliberately does not decode or check `exp`; see `requiredMintedToken` for why an expiry check at
 * boot would crash-loop this service and its migrator on every restart.
 */
const MINTED_TOKEN =
  'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlbWJlcmtpbiIsImV4cCI6MH0.c2lnbmF0dXJl';

const BASE: Record<string, string> = {
  EMBERKIN_DATABASE_URL: 'postgres://emberkin:emberkin@127.0.0.1:5432/emberkin',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  OUTBOX_SIGNING_SECRET: generatedKey(),
  LEDGER_URL: 'http://ledger',
  BILLING_URL: 'http://billing',
  WORLDS_URL: 'http://worlds',
  EMBERKIN_SERVICE_TOKEN: MINTED_TOKEN,
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

test('env: the service token must be a MINTED token, not a typed string', () => {
  // `index.ts:60` presents this value verbatim as a Bearer, so a non-JWT here 401s all three
  // upstreams with nothing in either log naming the cause. The old assertion was `'short'`, which a
  // 24-character floor caught by accident; the value that mattered is the compose DEFAULT, which is
  // 40 characters, was on no deny-list, and booted.
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: 'short' }), EnvError);
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: 'estate-placeholder-token-0000000000000000' }),
    (err: unknown) => err instanceof EnvError && /not a minted service token/.test(err.message),
  );
  // A `cfsc_` credential is the OTHER wrong answer, and the tempting one: the estate mints
  // `EMBERKIN_IDENTITY_CREDENTIAL` and it sits in tokens.env looking like it belongs here.
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: 'cfsc_vFpu5q-4UwZTvGSezkD9nTOy8r6lxWbhIBm8eaJoXiE' }),
    (err: unknown) => err instanceof EnvError && /not a minted service token/.test(err.message),
  );
  assert.equal(loadEnv(BASE).serviceToken, MINTED_TOKEN);
});

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED — micro-org #142/#212', () => {
  // 40 characters, on nobody's deny-list, live on 44 containers across both networks. It cleared
  // the guard this file used to carry, which is the entire defect: a membership test can only
  // catch placeholders somebody already imagined.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'estate-only-outbox-secret-00000000000000' }),
    (err: unknown) => err instanceof EnvError && /reads as a placeholder/.test(err.message),
  );
  // Long enough for the old floor twice over, and degenerate. Characters were never the unit.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'x'.repeat(48) }),
    (err: unknown) => err instanceof EnvError && /entropy/.test(err.message),
  );
  // The fixture this file used to boot on, named so the regression is unmistakable.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'a-real-secret-of-sufficient-length-000' }),
    (err: unknown) => err instanceof EnvError && /sufficientlength/.test(err.message),
  );
  // Bytes, not keystrokes: 32 base64 characters carry only 24 bytes of key material.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(24).toString('base64') }),
    (err: unknown) => err instanceof EnvError && /24 bytes of key material/.test(err.message),
  );
});

test('env: a non-positive reward budget is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_SHARDS: '0' }), EnvError);
});

test('env: the budget is read as a bigint, never a float', () => {
  const env = loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_SHARDS: '9007199254740993' });
  assert.equal(env.seasonRewardBudgetShards, 9007199254740993n);
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * OUTBOX_ACCEPT_SECRETS — the overlap window that makes rotating the shared HMAC key survivable.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * GENERATED per run, both. The literals that used to sit here —
 * `'rotation-fixture-next-key-not-a-real-secret'` and its prior twin — normalise to strings
 * containing `notareal`, a marker on `@cloudsforge/secrets`' list, and are hyphenated prose rather
 * than key material. They were refused the moment the list stopped being a place where the rule
 * relaxes, which is the correct outcome and the reason they are gone.
 */
const NEXT_KEY = generatedKey();
const PRIOR_KEY = generatedKey();

test('env: absent OUTBOX_ACCEPT_SECRETS, the service accepts exactly the signing secret', () => {
  // The no-op property. Deploying this changes nothing until an operator sets the variable, which
  // is what lets the estate's shared key be rotated one service at a time rather than on a flag day.
  assert.deepEqual([...loadEnv(BASE).acceptSecrets], [BASE.OUTBOX_SIGNING_SECRET]);
});

test('env: OUTBOX_ACCEPT_SECRETS is a comma-separated list, newest first, and signing stays single', () => {
  const env = loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ` ${NEXT_KEY} , ${PRIOR_KEY} ` });
  assert.deepEqual([...env.acceptSecrets], [NEXT_KEY, PRIOR_KEY]);
  // Signing is NOT a list: two outbound signatures would double every subscriber's verification
  // work and leave nobody able to say which key an event was signed with.
  assert.equal(env.outboxSigningSecret, BASE.OUTBOX_SIGNING_SECRET);
});

test('env: every OUTBOX_ACCEPT_SECRETS entry faces the bar a single secret faces', () => {
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},changeme` }), /placeholder/);
  // The entry is named by INDEX and never quoted — an operator with the file open can count commas,
  // and a log collector must not be handed the value.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},short` }),
    (err: unknown) => err instanceof EnvError && /OUTBOX_ACCEPT_SECRETS\[1\]/.test(err.message),
  );
  // The one that matters: 40 characters, refused by no deny-list, accepted by the old list guard
  // because "just for the drain" is how a placeholder survives a rotation meant to remove it.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},estate-only-outbox-secret-00000000000000` }),
    (err: unknown) => err instanceof EnvError && /reads as a placeholder/.test(err.message),
  );
  // A list of separators would be an empty accept list, which refuses every producer in the estate.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ' , , ' }), /at least one secret/);
});

test('env: OUTBOX_ACCEPT_SECRETS listing the same secret twice is refused', () => {
  // A duplicate makes "which key verified this" ambiguous, and that answer is how an operator
  // knows the rotation has finished and the old key may be dropped.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},${NEXT_KEY}` }), /twice/);
});
