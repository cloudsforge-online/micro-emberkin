/**
 * The merged surface: both titles, one listener, driven over a real socket against BOTH databases.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE ONLY TEST THAT SEES WHAT THE PROCESS ACTUALLY IS.**
 *
 * `server.test.ts` drives emberkin alone and `aetherholm/server.test.ts` drives aetherholm alone,
 * and both still pass unchanged — which is how we know the merge did not alter either title's own
 * surface, and also the reason neither can see any of the five things a merge can break:
 *
 *   1. **A route reading the wrong module's database.** The kernel resolves ONE handle per request
 *      from ONE selector. Mounted without `RouteSpec.sql`, aetherholm's handlers would be handed
 *      emberkin's database — and the two schemas share SIX table names, so
 *      `select … from seasons` would SUCCEED against another game's rows. Neither single-module
 *      suite can see it, because in each of them there is only one database.
 *   2. **Two `/livez`, `/readyz`, `/metrics`.** Matching is first-wins, so the second copy of each
 *      is simply dead — and a dead health endpoint looks exactly like a live one.
 *   3. **A `/readyz` that reports half the process.** Emberkin's Lifecycle probing only emberkin's
 *      database answers 200 while every city, fleet and provision is failing — and
 *      `aetherholm-web` reads that endpoint through `cf-api-aetherholm-readyz` to tell a player
 *      whether the game is up.
 *   4. **An erasure that reaches one title.** BOTH subscribe to `identity.user.deleted`. One
 *      webhook routing it to one module answers 202 to a deletion half of which never happened,
 *      and nothing retries because nothing failed.
 *   5. **Job metrics that erase each other.** `jobs_pending` and `jobs_overdue` carry no `kind`,
 *      so before the `module` label each module's sample OVERWROTE the other's and a wedged queue
 *      was ABSENT from the graph rather than high.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two databases are required, and the suite skips without both. It is the one file in this
 * repository that needs `EMBERKIN_TEST_DATABASE_URL` and `AETHERHOLM_TEST_DATABASE_URL` at once,
 * and `service-ci.yml` provides exactly that — one CI database per declared variable, for the
 * reason `migratortargets.test.ts` measures.
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { TokenError, type Principal } from '@cloudsforge/auth';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry';
import { GameData } from './content/gamedata.ts';
import { createMergedServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts';
import {
  ALICE,
  CONTRACT_SIGNATURE_HEADER,
  asDb,
  enabled as emberkinEnabled,
  fakeBilling,
  migrateTestDb,
  openDb,
  quietLogger,
  resetEmberkin,
  signedEvent,
  skip as emberkinSkip,
} from './testsupport.ts';
import {
  enabled as aetherholmEnabled,
  migrateTestDb as migrateAetherholmDb,
  openDb as openAetherholmDb,
  resetAetherholm,
} from './aetherholm/testsupport.ts';
import { ensureOpenSeason } from './aetherholm/seasons.ts';

/*
 * ── THE AETHERHOLM MODULE VALIDATES ITS CONFIGURATION AT IMPORT AND EXITS ON A BAD ONE ─────────
 *
 * Right for a service, fatal for a test runner — `aetherholm/env.test.ts` records the same problem
 * and solves it the same way. So a complete environment is populated FIRST and the module is then
 * imported dynamically.
 *
 * The signing secret is generated per run rather than written as a literal, for the reason
 * micro-org #142 records at length: a hyphenated placeholder that clears a length check is the
 * exact family of value the estate actually shipped, and no repository should hold a string that
 * looks like key material. `assertGeneratedSecret` refuses one anyway.
 *
 * The DSN is this suite's own test database, so the module's aetherholm half reads the same
 * database `resetAetherholm` truncates.
 */
const AETHERHOLM_TEST_DSN_VAR = 'AETHERHOLM_TEST_DATABASE_URL';
process.env['AETHERHOLM_DATABASE_URL'] =
  process.env[AETHERHOLM_TEST_DSN_VAR] ?? ['postgres://u:p@127.0.0.1:5432', 'unset_test'].join('/');
process.env['OUTBOX_SIGNING_SECRET'] ??= randomBytes(48).toString('base64');
process.env['IDENTITY_JWKS_URL'] ??= 'http://127.0.0.1:4001/.well-known/jwks.json';
process.env['IDENTITY_ISSUER'] ??= 'http://127.0.0.1:4001';
const { createAetherholmModule } = await import('./aetherholm/module.ts');

/** The one secret the merged webhook verifies against — for BOTH modules. See the fan-out below. */
const EVENT_SECRET = 'test-signing-secret-of-good-length-000';

const data = GameData.loadFromDirectory();

/** ALICE is a user of both titles here — which is the whole point of the erasure case. */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    throw new TokenError('unknown token', 'invalid');
  },
};

const skip = emberkinEnabled && aetherholmEnabled ? false : emberkinSkip || `set ${AETHERHOLM_TEST_DSN_VAR}`;

describe('the merged surface', { skip }, () => {
  let emberkinSql: postgres.Sql;
  let aetherholmSql: postgres.Sql;
  let aetherholm: Awaited<ReturnType<typeof createAetherholmModule>>;
  let server: Server;
  let url: string;
  let registry: Metrics;
  let seasonName: string;
  let stopped = false;
  const enqueued: { kind: string; key: string }[] = [];

  before(async () => {
    emberkinSql = openDb();
    await migrateTestDb(emberkinSql);
    await resetEmberkin(emberkinSql);

    aetherholmSql = openAetherholmDb();
    await migrateAetherholmDb(aetherholmSql);
    await resetAetherholm(aetherholmSql);

    // A real open season, made the way the `season.ensure` job makes one — so `GET
    // /v1/seasons/current` has something to answer with, out of the `seasons` table BOTH titles own.
    const season = await ensureOpenSeason(asDb(aetherholmSql) as never, 'aetherholm', new Date());
    seasonName = season.name;

    // Exactly the arrangement `index.ts` builds: ONE registry rendered by /metrics, a labelled view
    // per module for the JOB plane only, one Lifecycle with two hard probes, both route tables on
    // one listener, and the mounted module's inbound sink on the one webhook.
    registry = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));
    const jobMetrics = registry.withLabels({ module: 'emberkin' });

    // `cacheMs: 0` because a case below asserts what /readyz says a moment AFTER a database goes
    // away, and the default one-second cache would answer with the report from before it did.
    const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100, cacheMs: 0 });

    aetherholm = await createAetherholmModule({
      metrics: registry,
      verifier,
      claimingJobs: () => false,
      track: () => lifecycle.track(),
    });

    lifecycle.addProbe(postgresProbe('postgres-emberkin', () => emberkinSql`select 1`));
    lifecycle.addProbe(aetherholm.probe);

    server = createMergedServer(
      {
        lifecycle,
        logger: quietLogger(),
        // The REGISTRY, not a view: /metrics renders this object, and the kernel's HTTP metrics are
        // process-wide — one listener serves both modules and `route` already says which.
        metrics: registry,
        verifier,
        sql: networkSql({ mainnet: asDb(emberkinSql) as unknown as RuntimeSql }),
        singleNetwork: 'mainnet' as const,
        producer: 'emberkin',
        data,
        billing: fakeBilling(),
        queueFor: () => ({ enqueue: async (o) => void enqueued.push({ kind: o.kind, key: o.key }) }),
        eventAcceptSecrets: [EVENT_SECRET],
        inbound: [aetherholm.inbound],
        beforeScrape: async () => {
          jobMetrics.set('jobs_pending', 0, { network: 'mainnet' });
          jobMetrics.set('jobs_overdue', 0, { network: 'mainnet' });
          await aetherholm.beforeScrape();
        },
      },
      aetherholm.routes,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    lifecycle.markReady();
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!stopped && aetherholm) await aetherholm.stop();
    if (emberkinSql) await emberkinSql.end({ timeout: 5 }).catch(() => {});
    if (aetherholmSql) await aetherholmSql.end({ timeout: 5 }).catch(() => {});
  });

  const auth = { authorization: 'Bearer alice', 'content-type': 'application/json' };

  /* ---------------------------------------------------------------- route table */

  describe('the two route tables are mounted, and neither shadows the other', () => {
    it("answers emberkin's reads", async () => {
      const res = await fetch(`${url}/v1/content/dex`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dex: unknown[] };
      assert.ok(body.dex.length > 0, "emberkin's content is served from emberkin's own GameData");
    });

    it("answers aetherholm's title contract on the SAME listener and the SAME port", async () => {
      // The route `worlds` calls. Public and unauthenticated by design.
      const res = await fetch(`${url}/v1/title`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { slug: string; capabilities: string[] };
      assert.equal(body.slug, 'aetherholm');
      assert.deepEqual(body.capabilities, ['private_world']);
    });

    it('and an unknown path is still one 404 for the whole process', async () => {
      const res = await fetch(`${url}/v1/no-such-route`);
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_found');
    });
  });

  /* ---------------------------------------------------------------- the right database */

  describe("every aetherholm route reads AETHERHOLM's database, not the host's", () => {
    it('serves a table that exists only in the aetherholm schema', async () => {
      // `archipelagos` is aetherholm's. Emberkin's database has no such table, so a route handed
      // the host's selector would 500 here rather than answer — which is the whole reason
      // `RouteSpec.sql` exists.
      const res = await fetch(`${url}/v1/archipelagos`, { headers: auth });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { archipelagos: unknown[] };
      assert.ok(Array.isArray(body.archipelagos));
    });

    it("reads the AETHERHOLM seasons table, and emberkin's identically-named one is not it", async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * BOTH MODULES OWN A TABLE CALLED `seasons`, WITH DIFFERENT COLUMNS.
       *
       * A row is planted in each. The aetherholm read must answer from the schema that has
       * `seed`, `opened_at` and a `public` archipelago joined to it; run against emberkin's
       * `seasons` — which has `slug`, `starts_at` and `reward_budget_wei` — the same statement
       * is a 500, and mounted without `RouteSpec.sql` that is exactly where it would have run.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      await emberkinSql`
        insert into seasons (slug, name, starts_at, ends_at, status, reward_budget_wei)
        values ('merged-test', 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE', now(), now() + interval '30 days',
                'active', 1000)
        on conflict (slug) do nothing
      `;

      const res = await fetch(`${url}/v1/seasons/current`, { headers: auth });
      assert.equal(res.status, 200, 'against emberkin’s seasons table this statement is a 500');
      const body = (await res.json()) as { name: string; seed: string; archipelagoId: string };
      assert.equal(body.name, seasonName, 'the merged read must answer from aetherholm’s season');
      assert.notEqual(body.name, 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE');
      assert.match(body.seed, /^\d+$/, 'aetherholm’s seasons carry a seed; emberkin’s have no such column');
    });

    it("and emberkin's own reads still see emberkin's rows", async () => {
      const rows = await emberkinSql<{ name: string }[]>`select name from seasons where slug = 'merged-test'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.name, 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE');

      // And aetherholm's database never saw it — the two `seasons` tables are two tables.
      const theirs = await aetherholmSql<{ n: number }[]>`
        select count(*)::int as n from seasons where name = 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE'
      `;
      assert.equal(theirs[0]?.n, 0);
    });
  });

  /* ---------------------------------------------------------------- one of each infra route */

  describe('one process serves exactly one of each operational route', () => {
    it('/livez answers 200', async () => {
      assert.equal((await fetch(`${url}/livez`)).status, 200);
    });

    it('/metrics answers 200 and is emberkin’s, which is what Prometheus scrapes', async () => {
      assert.equal((await fetch(`${url}/metrics`)).status, 200);
    });

    it('and the aetherholm module mounted none of the four it drops', async () => {
      // Stated as a test rather than in a comment, because it is the property `mountableRoutes`
      // exists for and the one a careless edit would undo. `mergedroutes.test.ts` proves the
      // overlap is exactly these four; this proves the module actually dropped them.
      const mounted = aetherholm.routes.map((r) => `${r.method} ${r.path}`);
      for (const dead of ['GET /livez', 'GET /readyz', 'GET /metrics', 'POST /v1/events']) {
        assert.ok(!mounted.includes(dead), `${dead} was mounted twice — the second copy is dead`);
      }
      assert.ok(mounted.length > 25, `only ${mounted.length} aetherholm routes mounted`);
      // And every one that survived carries this module's selector. Remove the stamp and the two
      // database cases above go red; this says WHY they would.
      for (const spec of aetherholm.routes) {
        assert.notEqual(spec.sql, undefined, `${spec.method} ${spec.path} would read emberkin's database`);
      }
    });
  });

  /* ---------------------------------------------------------------- the shared webhook */

  describe('POST /v1/events verifies ONCE and fans out to every module that subscribes', () => {
    it("delivers identity.user.deleted to BOTH titles' databases, checked directly", async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * THE CASE THE FAN-OUT EXISTS FOR.
       *
       * Before the merge, identity's relay held one subscription row per service and delivered
       * this event twice. After it there is ONE endpoint. Route it to one module and the other
       * title never erases — the deletion answers 202, the producer marks it delivered, and every
       * city that person founded is still standing. Nothing retries, because nothing failed.
       *
       * So this asserts the ROWS, in both databases, and not the 202.
       *
       * The seed rows are the estate's own erasure-drill fixtures, verbatim from
       * `deploy/erasure/register.psv`.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const archipelagoId = '00000000-0000-4000-8000-0000000d5111';
      await emberkinSql`
        insert into saves (user_id, warden_name, seed, current_region)
        values (${ALICE}, 'Drill', 1, 'ember-vale')
      `;
      await aetherholmSql`
        insert into archipelagos (id, kind, name, seed, owner_subject, entitlement_id)
        values (${archipelagoId}::uuid, 'skerry', 'Drill', 1, ${`user:${ALICE}`}, 'drill-ent')
        on conflict do nothing
      `;
      await aetherholmSql`
        insert into research (archipelago_id, user_id, node) values (${archipelagoId}, ${ALICE}, 'drill-node')
      `;

      const before = {
        saves: (await emberkinSql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`)[0]?.n,
        research: (await aetherholmSql<{ n: number }[]>`select count(*)::int as n from research where user_id = ${ALICE}`)[0]?.n,
      };
      assert.deepEqual(before, { saves: 1, research: 1 }, 'both titles must hold something to lose');

      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'identity.user.deleted',
        payload: { userId: ALICE },
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 202);
      const reply = (await res.json()) as { status: string; erased?: boolean; fanout?: Record<string, string> };
      assert.equal(reply.status, 'accepted');
      assert.equal(reply.erased, true, "emberkin's own half ran");
      assert.deepEqual(reply.fanout, { aetherholm: 'processed' }, 'the mounted module must be named in the reply');

      // THE ROWS. A 202 proves nothing on its own — that is the failure this whole route shape
      // exists to prevent.
      const afterEmberkin = await emberkinSql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`;
      assert.equal(afterEmberkin[0]?.n, 0, "emberkin's save survived a deletion that answered 202");
      const afterAetherholm = await aetherholmSql<{ n: number }[]>`select count(*)::int as n from research where user_id = ${ALICE}`;
      assert.equal(afterAetherholm[0]?.n, 0, "aetherholm's rows survived a deletion that answered 202");
      const owner = await aetherholmSql<{ owner_subject: string }[]>`
        select owner_subject from archipelagos where id = ${archipelagoId}
      `;
      assert.match(owner[0]?.owner_subject ?? '', /^erased:/, 'the skerry owner must be anonymised, not left named');
    });

    it('writes an inbox row in EACH database, so redelivery is deduped per module', async () => {
      // The two `inbox` tables are two tables — one of the six colliding names. Each module's
      // dedupe is its own, which is what makes a redelivery a no-op for both rather than for one.
      const mine = await emberkinSql<{ n: number }[]>`select count(*)::int as n from inbox`;
      const theirs = await aetherholmSql<{ n: number }[]>`select count(*)::int as n from inbox`;
      assert.equal(mine[0]?.n, 1);
      assert.equal(theirs[0]?.n, 1);
    });

    it('refuses a bad signature with 403 before either module is reached', async () => {
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: 'v1=deadbeef', 'content-type': 'application/json' },
        body: JSON.stringify({ id: randomUUID(), topic: 'identity.user.deleted', payload: { userId: ALICE } }),
      });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_signature');
    });

    it('lets a sink REFUSE a malformed payload rather than acknowledging a deletion it cannot do', async () => {
      // A `userId` that is not a uuid. The standalone aetherholm route answered 400; the merged one
      // must too, and must NOT write emberkin's inbox row — because a redelivery is the only thing
      // that will ever make the other half happen.
      const inboxBefore = (await emberkinSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'identity.user.deleted',
        payload: { userId: 'not-a-uuid' },
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400);
      const err = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(err.error.code, 'bad_request');
      assert.match(err.error.message, /^aetherholm: /, 'the refusal must say which module refused');
      const inboxAfter = (await emberkinSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      assert.equal(inboxAfter, inboxBefore, 'a refused fan-out must not leave the host half acknowledged');
    });

    it('routes a topic only emberkin subscribes to, without troubling the other module', async () => {
      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'billing.entitlement.granted',
        payload: { sku: 'emberkin_season_pass', subject: `user:${ALICE}`, entitlementId: 'ent-merged-1' },
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 202);
      const reply = (await res.json()) as { status: string; reward?: string; fanout?: unknown };
      assert.equal(reply.reward, 'queued');
      assert.equal(reply.fanout, undefined, 'aetherholm does not subscribe, so it is not in the reply');
      assert.ok(enqueued.some((e) => e.key === 'ent-merged-1'), 'the reward job must still be enqueued');
    });

    it('still 202-ignores a topic NEITHER module subscribes to', async () => {
      // The ignore decision is taken against the UNION. A 4xx here would make the producer's relay
      // retry the same event for ever.
      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'pool.share.accepted',
        payload: {},
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 202);
      assert.equal(((await res.json()) as { status: string }).status, 'ignored');
    });
  });

  /* ---------------------------------------------------------------- one /metrics, two modules */

  describe('/metrics carries both modules, and their job series do not erase each other', () => {
    it("renders both modules' domain metrics from one registry", async () => {
      const text = await scrape();
      assert.match(text, /emberkin_battles_resolved_total/, "emberkin's series must be on the merged page");
      assert.match(text, /aetherholm_provisions_total/, "aetherholm's series must be on the merged page");
    });

    it('keeps jobs_pending as TWO series, one per module', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * THE COLLISION THIS WHOLE LABEL EXISTS FOR.
       *
       * `jobs_pending` and `jobs_overdue` carry no `kind`. Two modules calling
       * `metrics.set('jobs_pending', …)` against one registry write the IDENTICAL series, so
       * whichever samples last erases the other — and a wedged queue is then not "high" on the
       * graph, it is ABSENT from it. Nobody alerts on absent, and `JobQueueOverdue` in
       * `deploy/prometheus/rules/alerts.yaml` is `expr: jobs_overdue > 0`.
       *
       * emberkin's `network` label does NOT solve this: it distinguishes its two planes from each
       * other, never from aetherholm. `withLabels({ module })` is what makes each module's write a
       * different series. Both must be present after ONE scrape, which is the only arrangement in
       * which the erasure could have happened.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const lines = (await scrape()).split('\n');
      for (const metric of ['jobs_pending', 'jobs_overdue']) {
        const series = lines.filter((line) => line.startsWith(`${metric}{`));
        assert.ok(
          series.some((line) => line.includes('module="emberkin"')),
          `${metric} has no emberkin series — the aetherholm sample erased it:\n${series.join('\n')}`,
        );
        assert.ok(
          series.some((line) => line.includes('module="aetherholm"')),
          `${metric} has no aetherholm series — the emberkin sample erased it:\n${series.join('\n')}`,
        );
        assert.equal(series.length, 2, `${metric} must be exactly two series, one per module`);
      }
    });

    it('labels the counters that DO carry a kind, so two relays are two series', async () => {
      // Both modules register a job `kind="outbox.relay"`. Summing them would produce a number an
      // alert still fires on and nobody can act on. `jobcomposition.test.ts` proves the same
      // property against the registry directly, and proves the unlabelled shape collapses.
      registry.withLabels({ module: 'aetherholm' }).increment('jobs_failed_total', { kind: 'outbox.relay' });
      registry.withLabels({ module: 'emberkin' }).increment('jobs_failed_total', { kind: 'outbox.relay' });

      const failed = (await scrape()).split('\n').filter((line) => line.startsWith('jobs_failed_total{'));
      const relays = failed.filter((line) => line.includes('kind="outbox.relay"'));
      assert.equal(relays.length, 2, `two modules' relays must be two series:\n${failed.join('\n')}`);
      for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum');
    });

    it('renders the REGISTRY, so nothing about the page depends on which module wrote a series', async () => {
      // `/metrics` is handed the registry itself, not a view. Rendering a view would work — a view
      // shares the registry's series maps — but it reads as though the view owned the endpoint, and
      // that is what the next person adding a third module would copy. The observable half is
      // asserted here: every series, whoever wrote it, on one page.
      const text = await scrape();
      assert.match(text, /aetherholm_cities_founded_total/, "an emberkin-only render would omit aetherholm's");
      assert.match(text, /emberkin_service_token_static/);
      // And the process-wide HTTP metrics are NOT stamped with a module: one listener serves both,
      // and the `route` label already says which. A module label here would be a lie for half the
      // series on the page.
      const http = text.split('\n').filter((line) => line.startsWith('http_requests_total{'));
      assert.ok(http.length > 0, 'the kernel must have recorded the requests this suite made');
      for (const line of http) {
        assert.ok(!line.includes('module='), `http_requests_total must not claim a module: ${line}`);
      }
    });

    async function scrape(): Promise<string> {
      const res = await fetch(`${url}/metrics`);
      assert.equal(res.status, 200);
      return await res.text();
    }
  });

  /* ---------------------------------------------------------------- readiness covers both */

  describe('/readyz reflects BOTH databases', () => {
    it('names a hard probe for each module, and both pass', async () => {
      const res = await fetch(`${url}/readyz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> };
      assert.equal(body.ready, true);
      assert.deepEqual(
        body.checks.map((c) => c.name).sort(),
        ['postgres-aetherholm', 'postgres-emberkin'],
        'a merged /readyz that probes one database answers 200 while the other half is dead, and ' +
          'the balancer keeps sending traffic to it — and aetherholm-web tells the player the ' +
          'game is up',
      );
      for (const check of body.checks) assert.equal(check.state, 'pass', `${check.name} must be passing`);
    });

    // LAST, because it destroys the aetherholm half on purpose. It is the regression the plan names
    // in so many words, and the only way to prove it is to take that database away and read the
    // endpoint the load balancer — and `cf-api-aetherholm-readyz` — read.
    it('goes UNREADY when the aetherholm database is the one that has gone', async () => {
      await aetherholm.stop();
      stopped = true;

      const res = await fetch(`${url}/readyz`);
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> };
      const theirs = body.checks.find((c) => c.name === 'postgres-aetherholm');
      assert.notEqual(theirs, undefined, 'the aetherholm probe must still be reported');
      assert.notEqual(theirs?.state, 'pass', "aetherholm's database is gone and /readyz must say so");
      assert.equal(res.status, 503);
      assert.equal(body.ready, false);

      // And emberkin's is still fine, so this is not "everything broke" — it is one module reported
      // honestly, which is exactly what a merged readiness has to be able to do.
      assert.equal(body.checks.find((c) => c.name === 'postgres-emberkin')?.state, 'pass');
    });
  });
});
