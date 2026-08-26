/**
 * The server: this title's routes, mounted on the kernel.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE USED TO BE THE WHOLE HTTP SURFACE. It is now the seam between two halves:
 *
 *   - `kernel.ts` — the request lifecycle and the reply shapes. Knows no route and no service.
 *   - `routes.ts` — the routes, each handler CLOSED OVER `deps` rather than handed it.
 *
 * `createServer` keeps its signature, its export and its behaviour; every path, status, header,
 * cache directive and auth check is what it was. What changed is that the routes can now be
 * mounted by a process that also mounts somebody else's — the precondition for wave M3 of
 * micro-deploy `docs/service-merge-plan.md`, where emberkin absorbs aetherholm.
 *
 * `ServerDeps`, `PrincipalVerifier` and `WRITE_SCOPE` are re-exported here because that is where
 * `index.ts`, the tests and the rest of the estate have always imported them from. They are
 * DECLARED in `routes.ts`, beside the handlers that read them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Server } from 'node:http';
import { Metrics } from '@cloudsforge/telemetry';
import { mountRoutes, type RouteSpec } from './kernel.ts';
import { createRoutes, type ServerDeps } from './routes.ts';
import type { Db } from './outbox.ts';

export { WRITE_SCOPE, SUBSCRIBED_TOPICS, createRoutes } from './routes.ts';
export type { PrincipalVerifier, ServerDeps, InboundSink, InboundOutcome } from './routes.ts';

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

/**
 * The listener, emberkin's routes only.
 *
 * One line, and it says the whole design: build this title's routes against this title's
 * dependencies, then hand them to a kernel that cannot see either. Kept as its own export because
 * every one of `server.test.ts`'s cases drives exactly this surface, and because a merged listener
 * that could not also be built without the second module would make emberkin untestable alone.
 */
export function createServer(deps: ServerDeps): Server {
  return mountRoutes(createRoutes(deps), deps);
}

/**
 * The listener this process actually runs: emberkin's routes, then aetherholm's.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO DEPENDENCY BAGS, NEVER ONE.** `deps` is emberkin's and nothing else; `mounted` arrived as
 * closures that had already captured a bag this function has no name for. That asymmetry is the
 * merge's central safety property — this signature CANNOT be handed aetherholm's database, its
 * queue or its producer name, because there is no parameter one would arrive through.
 *
 * Order is first-wins, and emberkin goes first for one reason that is not a preference:
 * `/livez`, `/readyz` and `/metrics` are emberkin's in this process (see `aetherholm/module.ts`'s
 * `mountableRoutes` for why), and a mounted module must not be able to shadow them by accident.
 *
 * Checked, not assumed: `mergedroutes.test.ts` computes the two path sets and asserts the overlap
 * is EXACTLY the four paths the module filters out — the three operational ones and `POST
 * /v1/events`, which one handler serves for the whole process and fans out. A fifth collision
 * appearing later is a red test rather than a route that silently stops being reachable.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function createMergedServer(deps: ServerDeps, mounted: readonly RouteSpec<Db>[]): Server {
  return mountRoutes([...createRoutes(deps), ...mounted], deps);
}
