/**
 * Local fakes for the upstreams and the database harness.
 *
 * `fakeWorlds` is a REAL `node:http` server implementing the achievement bridge contract, so the
 * delivery job is exercised against a socket — its idempotency key, its auth header and its error
 * mapping are all genuinely tested, not stubbed.
 *
 * **A database test runs only against a database whose name says it is a test database.** Not a
 * convenience: `resetEmberkin` truncates every table this service owns, and requiring "test" in the
 * name is the difference between a red build and an emptied environment — this service holds the
 * only record of a player's progress.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { migrate, type Sql as DbSql } from '@cloudsforge/db';
import { Logger, Metrics } from '@cloudsforge/telemetry';
import { MIGRATIONS, TABLES } from './migrations.ts';
import { registerServiceMetrics } from './server.ts';
import type { EntitlementReader, EntitlementWire } from './billingclient.ts';
import type { LedgerClient, PostEntryRequest, PostedEntry } from './ledgerclient.ts';
import type { WorldsClient, AchievementPost } from './worldsclient.ts';
import type { Db } from './outbox.ts';

export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';

/* ------------------------------------------------------------------ the fake worlds service */

export interface FakeWorlds {
  readonly baseUrl: string;
  readonly token: string;
  readonly posted: ReadonlyArray<{ userId: string; code: string; idempotencyKey: string }>;
  /** Make the next N achievement posts fail with a 503, for the retry tests. */
  failNext(count: number): void;
  close(): Promise<void>;
}

export async function fakeWorlds(token = 'worlds-token'): Promise<FakeWorlds> {
  const posted: Array<{ userId: string; code: string; idempotencyKey: string }> = [];
  const byKey = new Set<string>();
  let failures = 0;

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      const payload = `${JSON.stringify(body)}\n`;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/livez') return reply(200, { ok: true });
    if (url.pathname === '/internal/achievements' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: { code: 'unauthenticated', message: 'token required' } });
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (failures > 0) {
          failures -= 1;
          return reply(503, { error: { code: 'unavailable', message: 'restarting' } });
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          return reply(400, { error: { code: 'bad_request', message: 'not json' } });
        }
        const key = String(body['idempotencyKey'] ?? '');
        const replayed = byKey.has(key);
        if (!replayed) {
          byKey.add(key);
          posted.push({ userId: String(body['userId'] ?? ''), code: String(body['code'] ?? ''), idempotencyKey: key });
        }
        return reply(replayed ? 200 : 201, { replayed });
      });
      return undefined;
    }
    return reply(404, { error: { code: 'not_found', message: 'no route' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    posted,
    failNext(count) {
      failures = count;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ billing */

export interface FakeBilling extends EntitlementReader {
  grant(userId: string, entitlement: EntitlementWire): void;
  setUnavailable(value: boolean): void;
}

export function fakeBilling(): FakeBilling {
  const owned = new Map<string, EntitlementWire[]>();
  let unavailable = false;
  const reader: FakeBilling = {
    grant(userId, entitlement) {
      owned.set(userId, [...(owned.get(userId) ?? []), entitlement]);
    },
    setUnavailable(value) {
      unavailable = value;
    },
    async list(userId) {
      if (unavailable) {
        const { BillingUnavailableError } = await import('./billingclient.ts');
        throw new BillingUnavailableError('the fake billing is unavailable');
      }
      return owned.get(userId) ?? [];
    },
    async owns(userId, itemUrn, scope) {
      const { skuOf } = await import('./billingclient.ts');
      const sku = skuOf(itemUrn);
      const entitlements = await reader.list(userId);
      return entitlements.some((entitlement) => {
        if (!entitlement.active || entitlement.sku !== sku) return false;
        if (!scope || scope === '*') return true;
        return entitlement.scope === 'platform' || entitlement.scope === `title:${scope}`;
      });
    },
  };
  return reader;
}

/* ------------------------------------------------------------------ ledger */

export interface FakeLedger extends LedgerClient {
  readonly entries: readonly PostEntryRequest[];
  readonly keys: readonly string[];
  failNext(err: Error): void;
}

export function fakeLedger(): FakeLedger {
  const entries: PostEntryRequest[] = [];
  const keys: string[] = [];
  const byKey = new Map<string, PostedEntry>();
  let failure: Error | null = null;
  let counter = 0;
  return {
    entries,
    keys,
    failNext(err) {
      failure = err;
    },
    async postEntry(request) {
      keys.push(request.idempotencyKey);
      if (failure) {
        const err = failure;
        failure = null;
        throw err;
      }
      const replay = byKey.get(request.idempotencyKey);
      if (replay) return { ...replay, replayed: true };
      counter += 1;
      entries.push(request);
      const entry: PostedEntry = { id: `entry-${counter}`, kind: request.kind, recordedAt: new Date(counter).toISOString(), replayed: false };
      byKey.set(request.idempotencyKey, entry);
      return entry;
    },
  };
}

/** A WorldsClient backed by the fake worlds server. */
export async function worldsClientFor(worlds: FakeWorlds): Promise<WorldsClient> {
  const { httpWorldsClient } = await import('./worldsclient.ts');
  return httpWorldsClient({ baseUrl: worlds.baseUrl, token: () => worlds.token, deadlineMs: 5_000 });
}

/** A WorldsClient that records posts in-process (no socket), for unit-level tests. */
export function fakeWorldsClient(): WorldsClient & { readonly posts: readonly AchievementPost[] } {
  const posts: AchievementPost[] = [];
  const seen = new Set<string>();
  return {
    posts,
    async postAchievement(post) {
      const replayed = seen.has(post.idempotencyKey);
      if (!replayed) {
        seen.add(post.idempotencyKey);
        posts.push(post);
      }
      return { replayed };
    },
  };
}

/* ------------------------------------------------------------------ the database harness */

const url = process.env['EMBERKIN_TEST_DATABASE_URL'];

export const enabled = Boolean(url && /test/i.test(url));

export const skip = enabled ? false : 'set EMBERKIN_TEST_DATABASE_URL (name must contain "test")';

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled');
  return postgres(url!, { max, onnotice: () => {} });
}

/** Bring the schema up. Idempotent — the real MIGRATIONS, so the constraints cannot drift from the tests. */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'emberkin-test' });
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetEmberkin(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`);
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'emberkin-test', sink: () => {} });
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics());
}

export function asDb(sql: postgres.Sql): Db {
  return sql as unknown as Db;
}

/** Sign an envelope the way a producer's relay would, for the inbound-webhook tests. */
export async function signedEvent(secret: string, envelope: Record<string, unknown>): Promise<{ body: string; signature: string }> {
  const { signEvent } = await import('./outbox.ts');
  const body = JSON.stringify(envelope);
  return { body, signature: signEvent(body, secret) };
}
