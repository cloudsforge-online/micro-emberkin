/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * It deliberately does NOT run migrations — that is `src/migrator.ts`, a separate one-shot — and it
 * asserts the schema version and refuses to serve below it, because below `SCHEMA_VERSION` the
 * outbox/inbox tables and the season budget CHECK may not exist.
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
import { createServer, registerServiceMetrics } from './server.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import { buildUpstreams } from './upstreams.ts';
import type { Db } from './outbox.ts';

// 1. Environment — validated on import of ./env.ts.

// 2. Telemetry, before anything that can fail.
const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env });
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));

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
  ['mainnet', sql],
  ...(sqlTestnet ? ([['testnet', sqlTestnet]] as const) : []),
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
lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // SOFT, all three: another service's outage must not pull the whole game from rotation, and above
  // all must not stop the achievement/reward job backlog from draining.
  .addProbe(httpProbe('billing', `${env.billingUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('worlds', `${env.worldsUrl}/livez`, { kind: 'soft' }));

// 8. Shared bundles — one set per network.
//
// The QUEUE is per-network too, and that is not incidental. A testnet request that enqueued into
// the mainnet queue would be picked up by a handler reading mainnet rows: a cross-network write
// that succeeds, with a job row to prove it was deliberate. One queue per database, one runner per
// queue, and neither can reach the other.
const db = sql as unknown as Db;
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
const queue = planeFor('mainnet').queue;

// 9. Routes.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer });
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: networkSql(Object.fromEntries(pools.map(([n, h]) => [n, h as unknown as DbSql]))),
  ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as Network } : {}),
  producer: SERVICE,
  data,
  billing,
  // The boot-time value. `forRequest` in server.ts replaces it with the queue for the request's
  // network before any route sees it.
  queue,
  queueFor: (network: Network) => planeFor(network).queue,
  // Absent `OUTBOX_ACCEPT_SECRETS` this is `[env.outboxSigningSecret]`, i.e. unchanged.
  eventAcceptSecrets: env.acceptSecrets,
  beforeScrape: async () => {
    // Per network, because the two queues are separate and a summed gauge would hide a testnet
    // backlog behind a healthy mainnet one.
    for (const plane of planes) {
      const stats = await plane.queue.stats();
      metrics.set('jobs_pending', stats.pending, { network: plane.network });
      metrics.set('jobs_overdue', stats.overdue, { network: plane.network });
    }
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
});

// 10. The job runners — ONE PER NETWORK, started before listen().
//
// Bulkheaded on purpose. A single runner over a single queue would drain mainnet and leave testnet
// jobs to accumulate for ever, and there would be no metric to say so: `jobs_pending` without a
// network label is a sum in which one healthy half hides the other. Each runner claims only from
// its own queue and every handler is registered against its own network's handle, so a handler
// physically cannot reach the other estate's rows.
const runners = planes.map((plane) => {
  const runner = new JobRunner({
    queue: plane.queue,
    concurrency: 4,
    pollMs: 1_000,
    shouldClaim: () => lifecycle.claimingJobs,
    onEvent: (event) => {
      if (event.kind) {
        const labels = { kind: event.kind, network: plane.network };
        if (event.type === 'claimed') metrics.increment('jobs_claimed_total', labels);
        if (event.type === 'completed') metrics.increment('jobs_completed_total', labels);
        if (event.type === 'failed') metrics.increment('jobs_failed_total', labels);
        if (event.type === 'dead') metrics.increment('jobs_dead_total', labels);
        if (event.durationMs !== undefined) metrics.observe('jobs_duration_ms', event.durationMs, labels);
      }
      onRunnerEvent(plane.queue, logger)(event);
    },
  });
  registerHandlers(runner, {
    sql: plane.db,
    logger,
    metrics,
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

// 11. Listen.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(env.port, () => resolve());
});
logger.info('listening', { port: env.port });

// 12. Ready.
lifecycle.markReady();

lifecycle.onShutdown(async () => {
  await Promise.all(pools.map(([, handle]) => handle.end({ timeout: 5 })));
  logger.info('database pools closed', { networks: pools.length });
});
lifecycle.onShutdown(async () => {
  const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean);
  logger.info('job runners stopped', { clean, runners: runners.length });
});
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }),
);

installSignalHandlers(lifecycle);
