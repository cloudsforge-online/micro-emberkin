/**
 * The composition root — for ALL THREE titles this process now serves.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * It deliberately does NOT run migrations — that is `src/migrator.ts`, a separate one-shot — and it
 * asserts the schema version and refuses to serve below it, because below `SCHEMA_VERSION` the
 * outbox/inbox tables and the season budget CHECK may not exist.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WAVES M3 AND M4a: THIS PROCESS IS THREE TITLES.** micro-deploy `docs/service-merge-plan.md`.
 * Emberkin absorbed aetherholm, and now nda: one image, one listener, one `/livez`, one `/readyz`,
 * one `/metrics`, and THREE databases that are never merged and must never be reachable from each
 * other's handlers.
 *
 * Emberkin absorbs rather than the other way round on the upstream argument, not on size:
 * aetherholm calls nothing at all and nda calls billing, worlds and identity — a strict SUBSET of
 * this service's ledger, billing, worlds and identity. So the merged process reaches exactly the
 * peers emberkin alone reached, and not one more. The reverse of either would have handed a title
 * a credential that can post to the ledger.
 *
 * **`tessera` was considered for this wave and REFUSED**, and the reason is worth having here
 * rather than only in a pull request, because it is the shape that stops the fourth title too:
 * `GET /v1/title` and `POST /v1/provision` are frozen constants in `@cloudsforge/contracts-worlds`,
 * and BOTH aetherholm and tessera mount them. Matching is first-wins, so in one process the second
 * title's descriptor and provision handler are simply dead — and `worlds` provisioning a paid
 * tessera ward would be answered, with a 200, by aetherholm. That cannot be fixed inside this
 * repository: the path is a published contract and `worlds` is out of this wave's scope.
 *
 * What this file may and may not see is the whole of the boundary:
 *
 *   * It builds emberkin's pools, queues and runners, exactly as before.
 *   * It calls `createAetherholmModule` and `createNdaModule` and receives, from each, routes, an
 *     inbound sink, readiness probes and a lifetime. **None of them names a database handle.**
 *     There is no parameter through which this file could hand a module the wrong pool, and no
 *     field through which it could take a module's.
 *   * `./aetherholm/env.ts` and `./nda/env.ts` are NOT imported here, so `AETHERHOLM_DATABASE_URL`,
 *     `NDA_DATABASE_URL` and `NDA_IDENTITY_CREDENTIAL` never enter this file's scope at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import postgres from 'postgres';
import { assertSchemaAtLeast, networkSql, type Network, type Sql as DbSql } from '@cloudsforge/db';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import { Verifier } from '@cloudsforge/auth';
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle';
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry';
import { SERVICE, env } from './env.ts';
import { SCHEMA_VERSION } from './migrations.ts';
import { GameData } from './content/gamedata.ts';
import { createMergedServer, registerServiceMetrics } from './server.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import { buildUpstreams } from './upstreams.ts';
import { MODULE_LABEL, createAetherholmModule } from './aetherholm/module.ts';
import { MODULE_LABEL as NDA_MODULE_LABEL, createNdaModule } from './nda/module.ts';
import type { Db } from './outbox.ts';

// ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
//
// Every per-network map in this file keys its primary entry by THIS, never by the literal
// `mainnet`. Same image, same code, different env: a testnet pod that hardcodes the key holds
// its own database and its own queue under the other estate's name, and then refuses — or, when
// the throw escapes a request listener, DIES — on every request the gateway correctly stamped.
//
// It happened twice. The handle, then the job plane.
const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet';


// 1. Environment — validated on import of ./env.ts.

// 2. Telemetry, before anything that can fail.
const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env });
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));

// ── THE LABELLED VIEW, AND WHY THE JOB PLANE NEEDS ONE ───────────────────────────────────────
//
// `/metrics` renders `metrics` — the REGISTRY — so every series any module writes is on one page.
// But two families collide and would be unreadable without a `module` label:
//
//   * All three titles register a job kind called `outbox.relay`, EXACTLY.
//     `jobs_failed_total{kind="outbox.relay"}` would be the sum of three unrelated relays.
//   * emberkin and nda BOTH register `achievement.sweep` and `achievement.deliver`. Two unrelated
//     achievement bridges, into two different `worlds` profiles, summed into one counter.
//   * `jobs_pending` and `jobs_overdue` carry no `kind` at all. Whichever module samples last
//     would be the only one on the graph — so a wedged queue reads as ABSENT rather than high,
//     and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` never fires for it.
//
// `withLabels` (micro-runtime#9) returns a VIEW that shares this registry's spec and series maps,
// so one `/metrics` still carries every module. The HTTP metrics stay unlabelled deliberately:
// one listener serves all three titles and the `route` label already says which.
const jobMetrics = metrics.withLabels({ module: SERVICE });

// 3. Content — loaded once, validated. A content error is a boot failure, not a first-request one.
const data = GameData.loadFromDirectory();
try {
  data.validateOrThrow();
} catch (err) {
  logger.fatal('content validation failed', { err });
  process.exit(1);
}
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  species: data.dex.length,
  seasonRewardBudgetWei: env.seasonRewardBudgetWei.toString(),
});

// 4. One pool per network this deployment serves.
//
// `EMBERKIN_DATABASE_URL_TESTNET` unset is the single-network case, and then `networkSql` holds one
// handle and REFUSES a testnet request rather than answering it out of mainnet rows. That refusal
// is the safety property: a substituted handle is a query that SUCCEEDS against the other estate's
// save games and says nothing. See micro-deploy `docs/network-consolidation.md`.
const poolOptions = { max: env.databasePoolMax, onnotice: () => {} };
const sql = postgres(env.databaseUrl, poolOptions);
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined;
const pools: ReadonlyArray<readonly [Network, typeof sql]> = [
  [ownNetwork, sql],
  ...(sqlTestnet && ownNetwork !== 'testnet' ? ([['testnet', sqlTestnet]] as const) : []),
];

// 5. Assert the schema on EVERY network, not only the first. A testnet database behind on
//    migrations would otherwise be discovered by the first testnet request rather than at boot.
for (const [network, handle] of pools) {
  try {
    await assertSchemaAtLeast(handle as unknown as DbSql, SCHEMA_VERSION);
  } catch (err) {
    logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION, network });
    await Promise.all(pools.map(([, h]) => h.end({ timeout: 5 }).catch(() => {})));
    process.exit(1);
  }
}

// 6. The upstreams. All three take the same scoped service token — never a shared one (SD-05).
//
// THE WIRING LIVES IN `./upstreams.ts` RATHER THAN HERE, and that is the substance of micro-org
// #228 rather than tidiness. What stood here was `const token = () => env.serviceToken`: a
// ten-minute JWT read once, at import, and handed to all three clients for the life of the process.
// No test in this repository could see it, because importing this file opens a pool, asserts a
// schema and calls `listen()` — so every test builds its own client, and a suite full of tests that
// build their own clients cannot see a composition root that builds a different one.
// `servicetoken.test.ts` goes through `buildUpstreams`, and reverting it turns that file red.
//
// NOTHING HERE IS REACHABLE FROM THE AETHERHOLM MODULE, and that is the merge's direction of
// travel made concrete: `createAetherholmModule` is handed a metrics registry, a verifier and two
// lifecycle bits, and there is no parameter through which `billing`, `ledger` or `worlds` could
// arrive. A title that called nothing before this merge calls nothing after it.
const upstreams = buildUpstreams(env, {
  // Never the token and never the credential: a mint carries a service name, an `expiresIn` and a
  // refresh interval, and a failure carries a message. Both values are live credentials.
  onEvent: (event) => {
    if (event.kind === 'minted') {
      logger.info('service token minted', {
        peer: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      });
    } else if (event.kind === 'exchange_failed') {
      // WARN while a usable token is still held, ERROR once there is not one. The distinction is
      // the whole of "a failed refresh must not present as success": inside the 20% slack this is
      // survivable and invisible to callers; outside it, every outbound call is now answering 503.
      logger[event.hadUsableToken ? 'warn' : 'error']('service credential exchange failed', {
        err: event.err,
        hadUsableToken: event.hadUsableToken,
      });
    } else {
      logger.warn('service token replay', { kind: event.kind, url: event.url });
    }
  },
});
const { billing, ledger, worlds } = upstreams;

// THE MODE, SAID OUT LOUD AT BOOT. `static` is the defect still running: a deployment that has not
// yet been given the credential the bootstrap already minted for it. It is `fatal` rather than
// `warn` because the container will look perfectly healthy for ten minutes and then fail every
// outbound call with nothing in any log naming the cause — which is exactly how this survived long
// enough to become an issue. It does NOT exit: a rolling deploy has to be able to finish.
if (upstreams.mode === 'static') {
  logger.fatal('authenticating with a pre-minted service token, which expires ten minutes from now', {
    remedy: 'pass EMBERKIN_IDENTITY_CREDENTIAL instead of EMBERKIN_SERVICE_TOKEN',
    issue: 'micro-org#228',
  });
} else {
  logger.info('exchanging a long-lived service credential for short-lived tokens', { identityUrl: env.identityUrl });
}

// 7. The Lifecycle and its probes.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
});

// 8. The aetherholm module, built BEFORE the probes are wired and before the routes are mounted.
//
// It throws rather than exiting, so a fault in that half is reported by this file — which has a
// logger and a `fatal` line — instead of killing the process from inside a module.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer });
const aetherholm = await createAetherholmModule({
  // The REGISTRY, not a view. Its `aetherholm_*` names collide with nothing, and its job metrics
  // take a view of their own inside the module — see MODULE_LABEL there.
  metrics,
  // ONE JWKS client for the process. All three titles verify against the same identity.
  verifier,
  // The drain, and only the drain. A module does not decide the lifetime of a process it shares.
  claimingJobs: () => lifecycle.claimingJobs,
  track: () => lifecycle.track(),
}).catch(async (err: unknown) => {
  logger.fatal('the aetherholm module could not start', { err });
  await Promise.all(pools.map(([, h]) => h.end({ timeout: 5 }).catch(() => {})));
  process.exit(1);
});
logger.info('aetherholm module ready', { module: MODULE_LABEL, schemaVersion: aetherholm.schemaVersion });

// 8b. The nda module — wave M4a, and built exactly the way aetherholm's is.
//
// The rollback of the aetherholm module's own pools on a failure here is the module's, not this
// file's: `aetherholm.stop()` is the only thing that holds a name for them, which is why it is
// called rather than reached into.
const nda = await createNdaModule({
  // The REGISTRY, not a view. Its `nda_*` names collide with nothing, and its job metrics take a
  // view of their own inside the module — see MODULE_LABEL there.
  metrics,
  // ONE JWKS client for the process. All three titles verify against the same identity, from the
  // same two estate-wide variables. What each module still decides for itself is what a verified
  // principal may DO: `nda:write` is checked inside that module and this file cannot widen it.
  verifier,
  // The drain, and only the drain. A module does not decide the lifetime of a process it shares.
  claimingJobs: () => lifecycle.claimingJobs,
  track: () => lifecycle.track(),
}).catch(async (err: unknown) => {
  logger.fatal('the nda module could not start', { err });
  await aetherholm.stop().catch(() => {});
  await Promise.all(pools.map(([, h]) => h.end({ timeout: 5 }).catch(() => {})));
  process.exit(1);
});
logger.info('nda module ready', { module: NDA_MODULE_LABEL, schemaVersion: nda.schemaVersion });

lifecycle
  .addProbe(
    postgresProbe('postgres-emberkin', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
        }),
      ]),
    ),
  )
  // ── THE OTHER MODULE'S DATABASE, HARD, ON THE SAME `/readyz` ────────────────────────────────
  //
  // A merged readiness that probed one database would answer 200 while every city, fleet and
  // provision was failing — and `aetherholm-web` reads this endpoint through
  // `cf-api-aetherholm-readyz` to decide whether to tell a player the game is up. So it is not
  // just the balancer that would be misled; it is the page. `merged.test.ts` takes one database
  // away and asserts 503 while the other probes still pass.
  .addProbe(aetherholm.probe)
  // nda's are added AFTER this chain, because it contributes a LIST rather than one probe. See
  // the loop below the chain.
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // SOFT, all three: another service's outage must not pull the whole game from rotation, and above
  // all must not stop the achievement/reward job backlog from draining.
  .addProbe(httpProbe('billing', `${env.billingUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('worlds', `${env.worldsUrl}/livez`, { kind: 'soft' }));

// ── AND EVERY PROBE THE NDA MODULE CONTRIBUTES ─────────────────────────────────────────────────
//
// A LIST, and registered after the chain so it stays one: a module that later contributes a third
// probe does not have to touch this file, and nothing here has to know what any of them checks.
//
// TWO today, and the second is the one that changes what `/readyz` MEANS. `postgres-nda` is the
// same argument as `aetherholm.probe` above. `nda-identity-credential` is HARD, and it is nda's own
// standalone behaviour preserved: a replica with no credential can make no authenticated call to
// billing or worlds, so the equip button and the achievement bridge are both dead and it must take
// no traffic.
//
// SAY THE COST OUT LOUD, because it is the one thing this merge genuinely widens. Emberkin has NO
// `/readyz` router of its own, so `cf-api-aetherholm-readyz` and the apex
// `/worlds/aetherholm/readyz` clause are the only readiness published anywhere
// (`deploy/gateway/dynamic/estate-web.yml:1850,1880`). An unset `NDA_IDENTITY_CREDENTIAL` now
// renders as AETHERHOLM being down, on a public page, to a player who has never heard of nda.
// Making the probe soft was the alternative and it is worse: it would silently downgrade a
// guarantee this title shipped with, so that a module with no credential quietly took traffic and
// 503'd every write.
//
// nda's OWN billing, worlds and identity-jwks probes are deliberately NOT among them. All three
// read the same estate-wide `BILLING_URL`, `WORLDS_URL` and `IDENTITY_JWKS_URL` this file already
// probes, softly, under those exact names — so a second copy would be two identical rows in one
// readiness report and one more thing to keep in step. That is only true because nda's upstream
// set is a strict subset of this service's; `mergedupstreams.test.ts` is what keeps it true.
for (const probe of nda.probes) lifecycle.addProbe(probe);

// 9. Shared bundles — one set per network.
//
// The QUEUE is per-network too, and that is not incidental. A testnet request that enqueued into
// the mainnet queue would be picked up by a handler reading mainnet rows: a cross-network write
// that succeeds, with a job row to prove it was deliberate. One queue per database, one runner per
// queue, and neither can reach the other.
const planes = pools.map(([network, handle]) => ({
  network,
  db: handle as unknown as Db,
  queue: new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 }),
}));
const planeFor = (network: Network) => {
  const plane = planes.find((p) => p.network === network);
  if (!plane) throw new Error(`no plane for network ${network}`);
  return plane;
};

// 10. Routes — emberkin's, then aetherholm's, on one listener.
const server = createMergedServer(
  {
    lifecycle,
    logger,
    metrics,
    verifier,
    sql: networkSql(Object.fromEntries(pools.map(([n, h]) => [n, h as unknown as DbSql]))),
    ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as Network } : {}),
    producer: SERVICE,
    data,
    billing,
    queueFor: (network: Network) => planeFor(network).queue,
    // Absent `OUTBOX_ACCEPT_SECRETS` this is `[env.outboxSigningSecret]`, i.e. unchanged. BOTH
    // modules read the same estate-wide variables, from one file, which is what makes one
    // signature check honest for both.
    eventAcceptSecrets: env.acceptSecrets,
    // The single `POST /v1/events` fans out to every module that subscribes to the topic. ALL
    // THREE titles subscribe to `identity.user.deleted`, and routing it to one of them would answer
    // 202 to a deletion two thirds of which never happened. See `InboundSink` in `routes.ts`.
    //
    // One verification for all three: every module reads the same estate-wide
    // `OUTBOX_SIGNING_SECRET`/`OUTBOX_ACCEPT_SECRETS`, so a delivery that verifies for one verifies
    // for the others. That is checked rather than assumed — `mergedupstreams.test.ts` asserts no
    // mounted module declares an inbound secret variable of its own, which is exactly what made
    // tessera unmergeable on this route as well as on `/v1/title`.
    inbound: [aetherholm.inbound, nda.inbound],
    beforeScrape: async () => {
      // Per network, because the two queues are separate and a summed gauge would hide a testnet
      // backlog behind a healthy mainnet one — and through the LABELLED VIEW, because
      // `jobs_pending`/`jobs_overdue` carry no `kind` and the aetherholm module writes the same
      // two names. `network` alone does not distinguish this module from that one.
      for (const plane of planes) {
        const stats = await plane.queue.stats();
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network });
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network });
      }
      await aetherholm.beforeScrape();
      await nda.beforeScrape();
      // Read from what this process already holds; `snapshot()` dials nobody. A `static` deployment
      // reports usable, because the token it was handed genuinely is a bearer it can present — for
      // ten minutes. `emberkin_service_token_static` is the gauge that says it cannot be renewed.
      metrics.set(
        'emberkin_service_token_usable',
        upstreams.mode === 'exchanged'
          ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
            ? 1
            : 0
          : upstreams.mode === 'static'
            ? 1
            : 0,
      );
      metrics.set('emberkin_service_token_static', upstreams.mode === 'static' ? 1 : 0);
    },
  },
  // One flat table, concatenated in a fixed order. Order among the mounted modules does not decide
  // anything — `mergedroutes.test.ts` asserts every pair overlaps on exactly the four dropped
  // paths, which is what makes that true rather than merely likely.
  [...aetherholm.routes, ...nda.routes],
);

// 11. The job runners — ONE PER NETWORK, started before listen().
//
// Bulkheaded on purpose. A single runner over a single queue would drain mainnet and leave testnet
// jobs to accumulate for ever, and there would be no metric to say so: `jobs_pending` without a
// network label is a sum in which one healthy half hides the other. Each runner claims only from
// its own queue and every handler is registered against its own network's handle, so a handler
// physically cannot reach the other estate's rows.
//
// ── AND THE AETHERHOLM MODULE RUNS ITS OWN, WHICH IS FORCED RATHER THAN CHOSEN ───────────────
//
// A `JobRunner` is bound to ONE queue, bound to ONE handle, which is ONE database. Two databases
// cannot share a runner. They also could not share one if they wanted to: all three titles register
// a handler for `outbox.relay` — and emberkin and nda both register `achievement.sweep` and
// `achievement.deliver` on top — so `@cloudsforge/jobs`' `register()` throws `handler already
// registered for <kind>` on the second. `jobcomposition.test.ts` proves that throw is still
// reachable, because the SILENT arrangement is the one next door — N runners all counting
// `kind="outbox.relay"` into an unlabelled registry sum into one series that still moves. The
// `module` label above is what makes separate runners readable rather than merely correct.
const runners = planes.map((plane) => {
  const runner = new JobRunner({
    queue: plane.queue,
    concurrency: 4,
    pollMs: 1_000,
    shouldClaim: () => lifecycle.claimingJobs,
    onEvent: (event) => {
      if (event.kind) {
        const labels = { kind: event.kind, network: plane.network };
        // The VIEW. `network` distinguishes this runner from the other PLANE, never from the other
        // MODULE — aetherholm's relay writes `kind="outbox.relay"` too.
        if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', labels);
        if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', labels);
        if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', labels);
        if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', labels);
        if (event.durationMs !== undefined) jobMetrics.observe('jobs_duration_ms', event.durationMs, labels);
      }
      onRunnerEvent(plane.queue, logger)(event);
    },
  });
  registerHandlers(runner, {
    sql: plane.db,
    logger,
    metrics: jobMetrics,
    worlds,
    ledger,
    producer: SERVICE,
    signingSecret: env.outboxSigningSecret,
    seasonBudgetWei: env.seasonRewardBudgetWei,
    queue: plane.queue,
  });
  return runner;
});
// Recurring work is seeded into every queue: a testnet estate with no achievement sweep is a
// half-running game, not a dormant one.
for (const plane of planes) await seedRecurring(plane.queue);
for (const runner of runners) runner.start();
aetherholm.start();
// AWAITED, unlike aetherholm's, because this one seeds its recurring work before it starts its
// runners and a `world.sweep` that never got seeded is a game whose days stop advancing with
// nothing anywhere saying so. It is still before `listen()`, so no request can arrive against a
// module whose job plane has not started.
await nda.start();

// 12. Listen.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(env.port, () => resolve());
});
logger.info('listening', { port: env.port, modules: [SERVICE, MODULE_LABEL, NDA_MODULE_LABEL] });

// 13. Ready.
lifecycle.markReady();

lifecycle.onShutdown(async () => {
  await Promise.all(pools.map(([, handle]) => handle.end({ timeout: 5 })));
  logger.info('database pools closed', { networks: pools.length });
});
lifecycle.onShutdown(async () => {
  const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean);
  logger.info('job runners stopped', { clean, runners: runners.length });
});
// Each mounted module drains its own runners and closes its own pools. Registered as its own hook
// per module, so a failure in one module's shutdown does not skip another's — `Lifecycle` runs the
// hooks it holds, and one hook doing three modules' work would stop at the first that threw.
lifecycle.onShutdown(() => aetherholm.stop());
lifecycle.onShutdown(() => nda.stop());
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }),
);

installSignalHandlers(lifecycle);
