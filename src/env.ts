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

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'emberkin';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const PLACEHOLDERS = new Set([
  'changeme',
  'change_me',
  'change-me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
]);

type Source = Readonly<Record<string, string | undefined>>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`);
  return value;
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name);
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`);
  }
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`);
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
 * Every entry is held to exactly the bar `requiredSecret` holds a single one to: a list is not a
 * way to smuggle in a value that would be refused on its own. The parser is the house pattern —
 * `trade/src/env.ts:112` and `settlement/src/env.ts:433` carry the same shape.
 */
export function parseSecretList(raw: string, name: string, minLength = 24): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`);
  for (const entry of entries) {
    if (PLACEHOLDERS.has(entry.toLowerCase())) {
      throw new EnvError(`${name} contains a known placeholder — generate real secrets`);
    }
    if (entry.length < minLength) {
      throw new EnvError(`${name} entries must each be at least ${minLength} characters`);
    }
  }
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes the "which key verified this" answer ambiguous, and that answer is
    // what tells an operator whether a rotation has finished and the old key can be dropped.
    throw new EnvError(`${name} lists the same secret twice`);
  }
  return Object.freeze(entries);
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
  /** The scoped service credential. Not shared: SD-05. Carries billing:read, ledger:post, worlds:write. */
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
  const outboxSigningSecret = requiredSecret(source, 'OUTBOX_SIGNING_SECRET');

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
    serviceToken: requiredSecret(source, 'EMBERKIN_SERVICE_TOKEN'),
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
