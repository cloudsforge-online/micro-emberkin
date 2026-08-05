/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out has
 * nothing to justify it.
 *
 * Two behaviours are deliberate estate house style:
 *   1. A missing variable names itself (rather than surfacing as an unreadable driver error later).
 *   2. A known placeholder is refused outright — a default secret that boots is a default secret
 *      that reaches production.
 *
 * `EMBERKIN_SEASON_REWARD_BUDGET_SHARDS` is a MONEY CONTROL, not a tuning knob: season rewards are
 * ledger postings, so a game exploit that mints rewards is a money incident, and the cap is checked
 * in the same transaction as the posting.
 */

import { hostname } from 'node:os';
import { SecretError, assertGeneratedSecret, parseSecretList as parseGeneratedSecretList } from '@cloudsforge/secrets';

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'emberkin';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Source = Readonly<Record<string, string | undefined>>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`);
  return value;
}

/**
 * `@cloudsforge/secrets` raises `SecretError`; this file's contract is that `loadEnv` raises
 * `EnvError`, and every test and caller in this repository is written to that.
 *
 * So a shape failure is re-wrapped rather than rethrown, and the message is carried across
 * VERBATIM: it already names the variable and the command that fixes it, and by construction it
 * contains no part of the value. Only the class changes, so there is one thing to catch here and
 * nothing to re-derive by matching on text.
 */
function asEnvError(err: unknown): never {
  throw err instanceof SecretError ? new EnvError(err.message) : err;
}

/**
 * The estate's shared event-bus HMAC key, held to a SHAPE rather than to a deny-list.
 *
 * THE LOCAL `requiredSecret` AND ITS `PLACEHOLDERS` SET ARE GONE RATHER THAN KEPT IN FRONT, and
 * this is micro-org #212. They asked two questions — is the value one of nine exact strings, and
 * is it at least 24 characters — and `estate-only-outbox-secret-00000000000000` answered both
 * correctly: it was on nobody's list and it was 40 characters. That value sat on 54 lines of a
 * PUBLIC compose file and was live on 44 containers across both networks. A MEMBERSHIP TEST CAN
 * ONLY CATCH PLACEHOLDERS SOMEBODY ALREADY IMAGINED, so it fails in exactly the case that matters.
 *
 * `assertGeneratedSecret` measures instead: the base64 or hex alphabet and nothing else, at least
 * 32 decoded BYTES rather than 24 keystrokes, and a MEASURED Shannon entropy floor per alphabet.
 * `'x'.repeat(24)` is 24 characters and near-zero entropy, and is refused. There is no NODE_ENV
 * exemption and no escape hatch, so CI generates a real value per run rather than being let
 * through.
 *
 * It matters here specifically: this service VERIFIES inbound deliveries on `POST /v1/events` with
 * this key, and one of the topics that arrive there is `identity.user.deleted`. A forgeable key is
 * an anonymous erasure endpoint, and a missed delivery is an erasure obligation quietly not met.
 *
 * Measured live on 2026-08-06, both networks: 64 characters, base64, 48 bytes, 5.27 bits per
 * character — `openssl rand -base64 48`, exactly what the runbook says to run. So this refuses
 * nothing that is currently deployed.
 *
 * `required` in front of it and nothing else: the deleted checks were a strict subset of the
 * stronger ones, and running them first would answer a 40-character placeholder with "must be at
 * least 24 characters" — true, useless, and pointing the operator at the wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name);
  try {
    assertGeneratedSecret(name, value);
  } catch (err) {
    asEnvError(err);
  }
  return value;
}

/**
 * A JWT's first two segments. Matched on SHAPE, not decoded — this is a refusal, not a parse.
 */
const JWT_SHAPE = /^ey[A-Za-z0-9_-]*\./;

/**
 * A MINTED TOKEN, which is a fourth thing and not one of `@cloudsforge/secrets`' three classes.
 *
 * ── WHY THIS SLOT IS NOT `assertServiceCredential`, WHICH IS THE OBVIOUS ANSWER ────────────────
 *
 * Because `index.ts:60` is `const token = (): string => env.serviceToken` — the value is PRESENTED
 * as a bearer, verbatim, with no exchange. So it must be a ten-minute JWT from
 * `POST /service-tokens`, and `estate-bootstrap.sh` mints it into the CREDENTIALS list for exactly
 * that reason. `EMBERKIN_IDENTITY_CREDENTIAL` is also minted, by §5b, and sits in `tokens.env`
 * looking like the obvious answer; handing it here would send all three upstreams a Bearer that is
 * not a JWT and earn a 401 with nothing in either log naming the cause. THE GUARD CLASS IS NOT
 * PREDICTABLE FROM THE VARIABLE'S NAME, and it was measured rather than inferred — 2026-08-06, a
 * 698-character JWT on both networks.
 *
 * ── SO THIS IS A STOPGAP, AND ITS END IS NAMED ────────────────────────────────────────────────
 *
 * A ten-minute bearer read once at boot is micro-org #197/#222: the process authenticates for the
 * first ten minutes of its life and presents a corpse afterwards, with `/livez` green throughout
 * because it verifies nothing. The remedy is the one community 1.2.0, tessera 1.2.0 and admin-api
 * 1.3.0 already took — `ServiceTokenProvider` exchanging a long-lived credential and re-minting
 * before expiry — and it is filed rather than done here, because it is a different change from
 * this one and requires the compose block to stop passing the token.
 *
 * WHAT THIS GUARD BUYS TODAY, WHICH IS NOT NOTHING. The compose default when the bootstrap has not
 * run is `${EMBERKIN_SERVICE_TOKEN:-estate-placeholder-token-0000000000000000}` — 40 characters,
 * on nobody's deny-list, and the deleted guard passed it. A service booting on that 401s all three
 * upstreams silently. A JWT is generated by identity and cannot be typed by somebody in a hurry,
 * so requiring the shape refuses every placeholder this estate has ever written while accepting
 * exactly what the compose file says belongs here.
 *
 * NO EXPIRY CHECK, and that is deliberate rather than forgotten. `exp` is in the past on every
 * restart more than ten minutes after a bootstrap, so enforcing it would crash-loop this service
 * and `emberkin-migrate` with it. A boot check cannot fix a lifetime problem; exchange-and-refresh
 * can, and that is what #222 is for.
 */
function requiredMintedToken(source: Source, name: string): string {
  const value = required(source, name);
  if (!JWT_SHAPE.test(value)) {
    throw new EnvError(
      `${name} is not a minted service token — identity issues these as a JWT and this service ` +
        `presents the value verbatim as a Bearer, so a typed placeholder here 401s every upstream ` +
        `silently. Mint one with: deploy/scripts/estate-bootstrap.sh`,
    );
  }
  return value;
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * A comma-separated list of secrets, newest first.
 *
 * A LIST, not a value, because rotating `OUTBOX_SIGNING_SECRET` without an overlap window would
 * require every producer in the estate to change secret in the same instant this service does, and
 * that instant does not exist during a rolling deploy. A producer that moved first would simply be
 * refused — and one of the two topics this service consumes is `identity.user.deleted`, so a silent
 * partition is an erasure obligation quietly not met.
 *
 * Every entry is held to exactly the bar a single secret is held to, and since micro-org #212 that
 * bar is `assertGeneratedSecret` rather than a deny-list plus a 24-character floor. A LIST IS NOT A
 * PLACE WHERE THE RULE RELAXES: the OUTGOING key is the one an attacker already has if it leaked,
 * and "just for the drain" is exactly how a placeholder survives a rotation meant to remove it.
 *
 * THE BODY OF THIS FUNCTION IS GONE, not reimplemented. It was the eleventh copy of the same
 * parser in the estate — `trade/src/env.ts:112` and `settlement/src/env.ts:433` carried the others
 * — and eleven copies of a check are eleven chances for one of them to drift. `parseSecretList` in
 * `@cloudsforge/secrets` is the one copy, and it keeps the duplicate check this copy had.
 *
 * The signature is preserved because callers and tests in this repository are written to it; only
 * the argument order differs from the shared function, which takes the NAME first.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  try {
    return parseGeneratedSecretList(name, raw);
  } catch (err) {
    asEnvError(err);
  }
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`);
  }
  return value;
}

function shards(source: Source, name: string, fallback: bigint): bigint {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new EnvError(`${name} must be a whole number of shards (got ${raw})`);
  return BigInt(raw);
}

export interface Env {
  readonly port: number;
  readonly env: string;
  readonly version: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Rule 1: one database, named by this service's own variable. */
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly identityJwksUrl: string;
  readonly identityIssuer: string;
  /**
   * HMAC key for outbound event signatures, so a subscriber can prove an event came from us.
   * Exactly one, always: a producer signing under two keys at once has not rotated, it has forked,
   * and it doubles every subscriber's verification work for no gain.
   */
  readonly outboxSigningSecret: string;
  /**
   * The secrets `POST /v1/events` will ACCEPT, newest first, under BOTH inbound schemes.
   *
   * Defaults to `[outboxSigningSecret]` when `OUTBOX_ACCEPT_SECRETS` is unset, so a deploy that
   * does not set it behaves exactly as it does today, byte for byte. That is deliberate: it makes
   * shipping this a no-op, which is what lets the estate's shared key be rotated one service at a
   * time afterwards rather than on a flag day. See `outbox.ts`'s `verifyInbound` for why a single
   * value cannot be rotated at all.
   */
  readonly acceptSecrets: readonly string[];
  readonly instanceId: string;

  readonly ledgerUrl: string;
  readonly billingUrl: string;
  /** Worlds owns the shared profile + achievements; this service posts to it via the bridge. */
  readonly worldsUrl: string;
  /**
   * The scoped service TOKEN — a ten-minute JWT, not a credential, and the distinction is the whole
   * of micro-org #197/#222. `index.ts:60` presents it verbatim as a Bearer with no exchange, so it
   * must be what `POST /service-tokens` mints. Not shared: SD-05. Carries billing:read,
   * ledger:post, worlds:write. See `requiredMintedToken` for the guard and for why this slot is
   * being retired rather than made stricter.
   */
  readonly serviceToken: string;
  readonly upstreamDeadlineMs: number;

  /** The default reward budget a new Emberkin season is opened with, in Shards. */
  readonly seasonRewardBudgetShards: bigint;
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info');
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`);
  }
  const budget = shards(source, 'EMBERKIN_SEASON_REWARD_BUDGET_SHARDS', 100_000n);
  if (budget <= 0n) throw new EnvError('EMBERKIN_SEASON_REWARD_BUDGET_SHARDS must be positive');
  // Read before the object literal because the accept list falls back to it.
  const outboxSigningSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET');

  return {
    port: integer(source, 'PORT', 4100, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'EMBERKIN_DATABASE_URL'),
    databasePoolMax: integer(source, 'EMBERKIN_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    acceptSecrets: parseSecretList(
      optional(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
      'OUTBOX_ACCEPT_SECRETS',
    ),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    worldsUrl: required(source, 'WORLDS_URL'),
    serviceToken: requiredMintedToken(source, 'EMBERKIN_SERVICE_TOKEN'),
    upstreamDeadlineMs: integer(source, 'EMBERKIN_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    seasonRewardBudgetShards: budget,
  };
}

function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  );
  process.exit(1);
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname());
  } catch (err) {
    fatalConfig(err);
  }
})();
