/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * `POST /v1/events` is SIGNATURE-CHECKED BEFORE IT IS PARSED. An event webhook with no MAC lets
 * anyone who can reach the port assert a customer bought a season pass and get the reward paid, so
 * the body is verified against `OUTBOX_ACCEPT_SECRETS` over the exact bytes received, with a
 * timing-safe comparison, before `JSON.parse`. The handler then dedupes on the source event id via
 * `withInbox` and enqueues a leased reward job — it never posts to the ledger inline, so a ledger
 * outage cannot make the producer's relay redeliver.
 *
 * The SCHEME is `@cloudsforge/contracts-events`', not this repository's. It used to be a local
 * `sha256=<hmac>` under a locally-spelled header, which no producer in the estate sends, so every
 * inbound delivery answered 403 and every event this service emitted was refused by its consumers.
 * `outbox.ts` holds the measurement and the reason there is still a second, legacy arm.
 *
 * It serves TWO topics on that one route, `SUBSCRIBED_TOPICS`: `billing.entitlement.granted` and
 * `identity.user.deleted` (rule 6 of 03 §2 — see `erasure.ts` for what erasure means per table).
 * Anything else is 202'd and ignored, because a 4xx makes the producer's relay retry for ever.
 *
 * The fail-open / fail-closed split on cosmetics:
 *   `GET /v1/saves/me`            fails OPEN — it runs on every app load and reads only our own data.
 *   `PUT /v1/saves/me/cosmetics`  fails CLOSED with a 503 on a billing outage — "ask again later",
 *                                 never "wear it anyway".
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForbiddenError, TokenError, bearerFrom, requireScope, statusFor, type Principal } from '@cloudsforge/auth';
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db';
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry';
import type { JobQueue } from '@cloudsforge/jobs';
import {
  LEGACY_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  verifyInbound,
  withInbox,
  type Db,
} from './outbox.ts';
import type { GameData } from './content/gamedata.ts';
import type { EntitlementReader } from './billingclient.ts';
import { NotFoundError, ValidationError, findSave, getSave, startGame } from './savegame.ts';
import { eraseUser } from './erasure.ts';
import { resolveBattle } from './battles.ts';
import { CosmeticNotOwnedError, equipCosmetic } from './cosmetics.ts';
import { withOutbox } from './outbox.ts';
import { ACH_SWEEP_KIND, SEASON_REWARD_KIND } from './jobs.ts';
import type { KinSpec, ScriptAction } from './engine/replay.ts';

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>;
}

export const WRITE_SCOPE = 'emberkin:write';

/** Billing SKUs whose grant pays a season welcome reward. */
const SEASON_PASS_SKUS = new Set(['emberkin_season_pass', 'season_pass']);
const GRANTED_TOPIC = 'billing.entitlement.granted';
/** Rule 6 of docs/ecosystem/03 §2 — a service storing a `user_id` subscribes to this. See erasure.ts. */
const DELETED_TOPIC = 'identity.user.deleted';
/**
 * The topics this service acts on. Anything else is ACKNOWLEDGED and ignored — never 4xx'd, because
 * a 4xx makes the producer's relay retry the same event for ever.
 */
const SUBSCRIBED_TOPICS: ReadonlySet<string> = new Set([GRANTED_TOPIC, DELETED_TOPIC]);

export interface ServerDeps {
  readonly lifecycle: Lifecycle;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly verifier: PrincipalVerifier;
  /**
   * The per-network SELECTOR, not a handle. `NetworkSql` has no query methods, so a route that
   * reaches past `ctx.sql` for the process-wide pool does not compile. That is the point: a wrong
   * handle is not an error, it is a query that SUCCEEDS against the other estate's rows.
   */
  readonly sql: NetworkSql;
  /** `CF_NETWORK_SINGLE`, for `pnpm dev`, which has no gateway to stamp the header. */
  readonly singleNetwork?: Network;
  readonly producer: string;
  readonly data: GameData;
  readonly billing: EntitlementReader;
  /**
   * The boot-time queue. `forRequest` replaces it with the one for this request's network before
   * any route sees it — a testnet request that enqueued into the mainnet queue would be picked up
   * by a handler reading mainnet rows, which is a cross-network write with a job row to prove it
   * was deliberate.
   */
  readonly queue: Pick<JobQueue, 'enqueue'>;
  /** The per-network queues, selected once per request. */
  readonly queueFor: (network: Network) => Pick<JobQueue, 'enqueue'>;
  /**
   * Every key an inbound delivery may have been signed with, newest first — `OUTBOX_ACCEPT_SECRETS`,
   * defaulting to `[OUTBOX_SIGNING_SECRET]`. A LIST rather than a value because the estate's outbox
   * key is one secret shared by 24 services and swapping it partitions delivery; see `verifyInbound`.
   */
  readonly eventAcceptSecrets: readonly string[];
  readonly beforeScrape?: () => Promise<void>;
}

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'emberkin_battles_resolved_total',
      help: 'Battles resolved server-side, by outcome. `replayed` is an idempotent retry.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'emberkin_events_rejected_total',
      help: 'Inbound events refused, by reason. A climbing `bad_signature` is somebody probing the webhook.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'emberkin_events_accepted_total',
      help: 'Inbound events whose signature verified, by scheme. `legacy` reaching zero is what says billing has migrated and the legacy arm may be deleted.',
      kind: 'counter',
      labels: ['scheme'],
    })
    .register({
      name: 'emberkin_cosmetic_refusals_total',
      help: 'Attempts to equip a cosmetic the account does not own. Non-zero means a client believes it may.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'emberkin_achievements_unlocked_total',
      help: 'Achievements newly unlocked, bridged to the worlds shared profile.',
      kind: 'counter',
      labels: [],
    })
    .register({
      // THE CHECK THAT DID NOT EXIST WHILE THE TOKEN WAS DEAD (micro-org #228). `/livez` makes no
      // outbound call, so it answered 200 throughout — there was no signal anywhere that this
      // container could no longer authenticate to billing, the ledger or worlds. Sampled on every
      // scrape from the provider's own snapshot, which dials nobody.
      //
      // Deliberately NOT "is a token present": an expired token is retained after it dies, because
      // it is the most useful thing to show a diagnosing operator, and a gauge that read presence
      // as health would report 1 across exactly the outage it exists to reveal.
      name: 'emberkin_service_token_usable',
      help: '1 when this replica holds a service token it could present right now. 0 means every outbound call is answering 503.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      // 1 while this replica is running on a pre-minted `EMBERKIN_SERVICE_TOKEN`, which expires ten
      // minutes after the boot that read it. This reaching zero across the estate is what says the
      // compose change has landed everywhere and the variable may be deleted.
      name: 'emberkin_service_token_static',
      help: '1 when authenticating with a pre-minted token that cannot be renewed (micro-org #228). Should be 0 everywhere.',
      kind: 'gauge',
      labels: [],
    });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SEED_RE = /^\d{1,20}$/;

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff —
 * which is exactly what agora's first build did. A literal set rather than a prefix, because this
 * is an exemption from a data boundary and widening it should be a deliberate edit.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics']);

interface RequestContext {
  readonly req: IncomingMessage;
  readonly url: URL;
  readonly requestId: string;
  readonly log: Logger;
  readonly params: Readonly<Record<string, string>>;
  /**
   * The network THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped. Not a
   * property of the process: one pod serves both estates since the network consolidation, so
   * "which network am I" has no answer.
   */
  readonly network: Network;
  /**
   * The handle for `network`, resolved once at the edge. Routes use this rather than reaching for
   * `deps.sql`, which is a `NetworkSql` with no query methods — so the mistake does not compile.
   */
  readonly sql: Db;
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>;
}

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? `(?<${segment.slice(1)}>[^/]+)` : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes();
  let inFlight = 0;

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const presented = headerOf(req, 'x-request-id');
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId();
    res.setHeader('x-request-id', requestId);

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match) {
        matched = route;
        params = { ...match.groups };
        break;
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched';
    const log = deps.logger.child({ requestId, method, route: routeLabel });

    inFlight += 1;
    deps.metrics.set('http_requests_in_flight', inFlight);

    const finish = (status: number, metricNetwork: string): void => {
      inFlight -= 1;
      deps.metrics.set('http_requests_in_flight', inFlight);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      });
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      });
    };

    // ── THE NETWORK, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ──────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a cross-network write nothing would ever flag.
    //
    // The operational endpoints are exempt because kubelet and Prometheus do not come through the
    // gateway and never send the header. Refusing them makes the pod never become ready.
    const networkless = matched !== undefined && OPERATIONAL_ROUTES.has(matched.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? deps.sql.networks[0] ?? 'mainnet')
        : requestNetwork(req.headers, deps.singleNetwork ? { fallback: deps.singleNetwork } : {})
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(
        res,
        errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId),
        requestId,
      )
      finish(500, 'unknown')
      return
    }

    // ── RESOLVED INSIDE A TRY, AND THAT IS NOT DEFENSIVE PADDING ───────────────────────────────
    //
    // `deps.sql.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw escapes the `void` expression
    // past a `.catch` that is not attached yet, and the listener returns having sent NOTHING. The
    // connection then hangs until the client gives up: the one path the design most depends on
    // being loud was the one path that was silent.
    let sql: Db
    try {
      sql = deps.sql.for(network) as unknown as Db
    } catch (err) {
      log.error('no usable database handle for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }
    void handle(matched, { req, url, requestId, log, params, network, sql }, forRequest(deps, network))
      .then((reply) => {
        send(res, reply, requestId);
        finish(reply.status, network);
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err });
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId);
        finish(500, network);
      });
  });
}

/**
 * The deps a REQUEST sees.
 *
 * Everything that carries a database handle is rebuilt against this request's network. `sql` stays
 * the selector on `deps` (routes read `ctx.sql`), so the only thing to swap is the queue — but that
 * one matters: an enqueue is a write, and a write into the other estate's queue is invisible.
 */
function forRequest(deps: ServerDeps, network: Network): ServerDeps {
  return { ...deps, queue: deps.queueFor(network) };
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId);
  try {
    return await route.handle(ctx, deps);
  } catch (err) {
    const authStatus = statusFor(err);
    if (authStatus === 401) {
      ctx.log.info('unauthenticated request', { err });
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId);
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown';
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId);
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err });
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId);
    }
    if (err instanceof CosmeticNotOwnedError) {
      deps.metrics.increment('emberkin_cosmetic_refusals_total');
      return errorReply(403, 'cosmetic_not_owned', err.message, ctx.requestId);
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId);
    if (err instanceof BadRequestError || err instanceof ValidationError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId);
    }
    if (err instanceof Error && err.name === 'LedgerUnavailableError') {
      return errorReply(503, 'ledger_unavailable', 'the reward could not be paid; retry', ctx.requestId);
    }
    if (err instanceof Error && err.name === 'BillingUnavailableError') {
      // FAIL CLOSED. "Ask again later", not "wear it anyway".
      return errorReply(503, 'entitlements_unavailable', 'we cannot check your purchases right now — try again shortly', ctx.requestId);
    }
    ctx.log.error('unhandled request failure', { err });
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId);
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler });

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz();
      return { status: report.ready ? 200 : 503, body: report };
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.();
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err });
      }
      return { status: 200, text: deps.metrics.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
    }),

    /* --------------------------------------------------------------- the inbound webhook */

    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req);
      // Verified over the RAW BYTES, before `JSON.parse` — parsing first would let an
      // unauthenticated caller reach the parser. Two header names because this service's two
      // producers are on two schemes: identity signs the contract's `cf-signature`, billing still
      // sends the legacy `x-cloudsforge-signature`. `verifyInbound` carries the whole argument.
      const scheme = verifyInbound(raw.toString('utf8'), deps.eventAcceptSecrets, {
        contract: headerOf(ctx.req, SIGNATURE_HEADER) ?? '',
        legacy: headerOf(ctx.req, LEGACY_SIGNATURE_HEADER) ?? '',
      });
      if (scheme === null) {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'bad_signature' });
        ctx.log.warn('an inbound event failed its signature check');
        // NOT 401. This is not a bearer-token surface, and a 401 invites the caller to go and find
        // a token — there isn't one to find. The MAC is the credential.
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId);
      }
      // Reported so the legacy arm is deleted on evidence rather than on a belief: when this stops
      // reading `legacy`, `micro-billing`'s relay has moved and the arm can go.
      deps.metrics.increment('emberkin_events_accepted_total', { scheme });

      let envelope: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object');
        }
        envelope = parsed as Record<string, unknown>;
      } catch {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
        throw new BadRequestError('the event body is not valid JSON');
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : '';
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : '';
      if (!UUID.test(eventId)) {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
        throw new BadRequestError('an event envelope must carry a uuid id');
      }
      if (!SUBSCRIBED_TOPICS.has(topic)) {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'not_subscribed' });
        return { status: 202, body: { status: 'ignored', topic } };
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {};

      const done = deps.lifecycle.track();
      try {
        if (topic === DELETED_TOPIC) {
          // A BARE uuid, taken as it stands: every `user_id` column in this schema is a uuid, so
          // there is no `user:` prefix to strip here. That conversion belongs to billing's
          // `subject` below and the two must not be confused — stripping a prefix that is not there
          // would erase nobody and answer 202.
          const erasedUserId = typeof payload['userId'] === 'string' ? payload['userId'] : '';
          if (!UUID.test(erasedUserId)) {
            deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
            // 400 rather than a quiet 202: a deletion we cannot perform must not be acknowledged as
            // performed. That silence is the defect this handler exists to fix.
            throw new BadRequestError('identity.user.deleted requires a uuid userId');
          }
          const erasure = await withInbox(ctx.sql, topic, eventId, (tx) => eraseUser(tx, erasedUserId));
          if (erasure.status === 'duplicate') return { status: 202, body: { status: 'duplicate' } };
          if (erasure.value.battlesNotCascaded > 0) {
            ctx.log.error('battles did not cascade from saves — the foreign key has changed', {
              eventId,
              battles: erasure.value.battlesNotCascaded,
            });
          }
          // Counts, never the id: it is the thing we were just asked to forget.
          ctx.log.info('erased a user on identity.user.deleted', { eventId, ...erasure.value });
          return { status: 202, body: { status: 'accepted', erased: true } };
        }

        const sku = typeof payload['sku'] === 'string' ? payload['sku'] : '';
        const subject = typeof payload['subject'] === 'string' ? payload['subject'] : '';
        const entitlementId = typeof payload['entitlementId'] === 'string' ? payload['entitlementId'] : eventId;
        const userId = subject.startsWith('user:') ? subject.slice('user:'.length) : '';

        // Deduped on the source event id. A failed handler leaves no inbox row, so a redelivery is
        // reprocessed rather than swallowed.
        const outcome = await withInbox(ctx.sql, topic, eventId, async () => {
          return { qualifies: SEASON_PASS_SKUS.has(sku) && userId.length > 0 };
        });
        if (outcome.status === 'duplicate') return { status: 202, body: { status: 'duplicate' } };
        if (outcome.value.qualifies) {
          await deps.queue.enqueue({
            kind: SEASON_REWARD_KIND,
            key: entitlementId,
            payload: { userId, entitlementId },
            onConflict: 'keep',
          });
          return { status: 202, body: { status: 'accepted', reward: 'queued' } };
        }
        return { status: 202, body: { status: 'accepted' } };
      } finally {
        done();
      }
    }),

    /* --------------------------------------------------------------- saves */

    define('POST', '/v1/saves', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const wardenName = requireString(body, 'wardenName');
      const starter = requireString(body, 'starter');
      const seed = readOptionalSeed(body['seed']);
      const { save, created } = await startGame(
        ctx.sql,
        deps.producer,
        deps.data,
        { userId, wardenName, starter, ...(seed !== null ? { seed } : {}), correlationId: ctx.requestId },
        withOutbox,
      );
      return { status: created ? 201 : 200, body: serializeSave(save) };
    }),

    define('GET', '/v1/saves/me', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const save = await findSave(ctx.sql, userId);
      if (!save) return errorReply(404, 'not_found', 'no save for this account', ctx.requestId);
      return { status: 200, body: serializeSave(save) };
    }),

    define('POST', '/v1/saves/me/battles', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const key = headerOf(ctx.req, 'idempotency-key');
      if (!key || key.length < 1 || key.length > 200) {
        throw new BadRequestError('an Idempotency-Key header is required for a battle submission');
      }
      const body = await readJson(ctx.req);
      const enemy = parseEnemy(body['enemy']);
      const script = parseScript(body['script']);
      const seed = readOptionalSeed(body['seed']);
      const maxTurns = typeof body['maxTurns'] === 'number' ? body['maxTurns'] : undefined;

      const result = await resolveBattle(
        ctx.sql,
        deps.producer,
        deps.data,
        {
          userId,
          idempotencyKey: key,
          enemy,
          script,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(seed !== null ? { seed } : {}),
          correlationId: ctx.requestId,
        },
        withOutbox,
      );

      deps.metrics.increment('emberkin_battles_resolved_total', { outcome: result.replayed ? 'replayed' : result.outcome });
      if (result.unlocked.length > 0) {
        deps.metrics.increment('emberkin_achievements_unlocked_total');
        // Nudge the sweep so the badges reach worlds promptly; it would pick them up anyway.
        await deps.queue.enqueue({ kind: ACH_SWEEP_KIND, key: 'stream', onConflict: 'keep' });
      }
      return {
        status: 200,
        body: {
          battleId: result.id,
          outcome: result.outcome,
          turns: result.turns,
          replayed: result.replayed,
          log: result.log,
          unlocked: result.unlocked,
        },
      };
    }),

    define('PUT', '/v1/saves/me/cosmetics', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const slot = requireString(body, 'slot');
      const itemUrn = body['itemUrn'] === null ? null : typeof body['itemUrn'] === 'string' ? body['itemUrn'] : undefined;
      if (itemUrn === undefined) throw new BadRequestError('itemUrn must be a string or null');
      const equipped = await equipCosmetic(
        ctx.sql,
        deps.producer,
        deps.billing,
        deps.data,
        { userId, slot, itemUrn, correlationId: ctx.requestId },
        withOutbox,
      );
      return { status: 200, body: { equippedCosmetics: equipped } };
    }),

    define('GET', '/v1/saves/me/achievements', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const rows = await ctx.sql<{ code: string; name: string; points: number; unlocked_at: Date; delivered_at: Date | null }[]>`
        select code, name, points, unlocked_at, delivered_at from player_achievements
         where user_id = ${userId} order by unlocked_at desc
      `;
      return {
        status: 200,
        body: {
          achievements: rows.map((r) => ({
            code: r.code,
            name: r.name,
            points: r.points,
            unlockedAt: r.unlocked_at.toISOString(),
            delivered: r.delivered_at !== null,
          })),
        },
      };
    }),

    /* --------------------------------------------------------------- content (public, read) */

    define('GET', '/v1/content/dex', async (_ctx, deps) => ({
      status: 200,
      body: {
        dex: deps.data.dex.map((s) => ({ id: s.id, dexNumber: s.dexNumber, name: s.name, types: s.types })),
      },
    })),
  ];
}

/* --------------------------------------------------------------- auth + parsing helpers */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'));
  if (!token) throw new TokenError('no bearer token presented', 'missing');
  return deps.verifier.principal(token);
}

/** A user acting on their own save. A service principal must carry emberkin:write and name a user. */
async function requireUser(ctx: RequestContext, deps: ServerDeps): Promise<string> {
  const principal = await authenticate(ctx, deps);
  if (principal.kind === 'user') return principal.userId;
  // A service may act for a user it names in a header, but only with the write scope.
  requireScope(principal, WRITE_SCOPE);
  const onBehalf = headerOf(ctx.req, 'x-user-id');
  if (!onBehalf || !UUID.test(onBehalf)) throw new ForbiddenError('x-user-id (a service must name a user)');
  return onBehalf;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) throw new BadRequestError(`${field} is required`);
  return value.trim();
}

function readOptionalSeed(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && SEED_RE.test(value)) {
    const s = BigInt(value);
    if (s < 0n || s > 18446744073709551615n) throw new BadRequestError('seed out of range');
    return s;
  }
  throw new BadRequestError('seed must be a decimal string ulong');
}

function parseEnemy(value: unknown): { name: string; isWild: boolean; party: KinSpec[] } {
  if (typeof value !== 'object' || value === null) throw new BadRequestError('enemy is required');
  const e = value as Record<string, unknown>;
  const name = typeof e['name'] === 'string' ? e['name'] : 'Wild';
  const isWild = e['isWild'] === true;
  const rawParty = Array.isArray(e['party']) ? e['party'] : [];
  if (rawParty.length === 0) throw new BadRequestError('enemy.party must be a non-empty array');
  const party: KinSpec[] = rawParty.map((m) => {
    const k = m as Record<string, unknown>;
    if (typeof k['species'] !== 'string' || typeof k['level'] !== 'number') {
      throw new BadRequestError('each enemy party member needs species (string) and level (number)');
    }
    const spec: KinSpec = { species: k['species'], level: k['level'] };
    return {
      ...spec,
      ...(typeof k['resonance'] === 'number' ? { resonance: k['resonance'] } : {}),
      ...(typeof k['temperament'] === 'number' ? { temperament: k['temperament'] } : {}),
      ...(typeof k['nickname'] === 'string' ? { nickname: k['nickname'] } : {}),
    };
  });
  return { name, isWild, party };
}

function parseScript(value: unknown): ScriptAction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestError('script must be an array');
  return value.map((a) => {
    const s = a as Record<string, unknown>;
    const kind = s['kind'];
    if (kind !== 'move' && kind !== 'art' && kind !== 'catch' && kind !== 'flee' && kind !== 'switch' && kind !== 'item') {
      throw new BadRequestError(`unknown script action kind '${String(kind)}'`);
    }
    return {
      kind,
      ...(typeof s['slot'] === 'number' ? { slot: s['slot'] } : {}),
      ...(typeof s['move'] === 'string' ? { move: s['move'] } : {}),
      ...(typeof s['item'] === 'string' ? { item: s['item'] } : {}),
      ...(typeof s['index'] === 'number' ? { index: s['index'] } : {}),
    };
  });
}

function serializeSave(save: import('./savegame.ts').SaveState): Record<string, unknown> {
  return {
    userId: save.userId,
    wardenName: save.wardenName,
    seed: save.seed.toString(),
    currentRegion: save.currentRegion,
    storyProgress: save.storyProgress,
    playtimeSeconds: save.playtimeSeconds,
    party: save.party,
    box: save.box,
    inventory: save.inventory,
    seals: save.seals,
    dexSeen: save.dexSeen,
    equippedCosmetics: save.equippedCosmetics,
    saveVersion: save.saveVersion,
  };
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('request body is not valid JSON');
  }
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } };
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return;
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`;
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  });
  res.end(payload);
}
