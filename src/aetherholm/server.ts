/**
 * The listener, aetherholm's routes only — and the module's own domain metrics.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE USED TO BE THE WHOLE HTTP SURFACE. Wave M3 (micro-deploy `docs/service-merge-plan.md`)
 * split it in three:
 *
 *   - `../kernel.ts` — the request lifecycle and the reply shapes. Knows no route and no service.
 *   - `./routes.ts`  — the routes, each handler CLOSED OVER `deps` rather than handed it.
 *   - this file      — `createServer`, `registerServiceMetrics`, and the re-exports the rest of
 *                      the repository has always imported from here.
 *
 * `createServer` KEEPS ITS SIGNATURE AND ITS BEHAVIOUR, and that is load-bearing rather than
 * courteous: `server.test.ts`, `titlecontract.test.ts`, `erasure.test.ts` and `visibility.test.ts`
 * all drive this listener, and a merged process is not the thing they are testing. Every one of
 * them passes unchanged, which is the only way to know the merge did not quietly alter this
 * title's own surface while adding a second one beside it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Server } from 'node:http';
import { Metrics } from '@cloudsforge/telemetry';
import { mountRoutes } from '../kernel.ts';
import { createRoutes, type ServerDeps } from './routes.ts';

export { createRoutes } from './routes.ts';
export {
  PROVISION_SCOPE,
  READ_SCOPE,
  SUBSCRIBED_TOPICS,
  TITLE_DESCRIPTOR,
  TITLE_SLUG,
  WRITE_SCOPE,
} from './routes.ts';
export type { PrincipalVerifier, ServerDeps } from './routes.ts';

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'aetherholm_provisions_total',
      help: 'Title-contract provisions, by outcome. `replayed` is the idempotent second ask.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'aetherholm_cities_founded_total',
      help: 'Cities founded. A refound of an existing city does not count.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'aetherholm_queue_submissions_total',
      help: 'Queue submissions accepted, by kind. `replayed` marks idempotent retries.',
      kind: 'counter',
      labels: ['kind', 'replayed'],
    })
    .register({
      name: 'aetherholm_fleets_launched_total',
      help: 'Fleets launched, by mission. `replayed` marks idempotent retries.',
      kind: 'counter',
      labels: ['mission', 'replayed'],
    });
}

/**
 * This title's routes on a listener of their own.
 *
 * Not what the deployed process runs — that is `createMergedServer` in `../server.ts`, which
 * mounts these beside emberkin's — but it is what this title's whole suite drives, and keeping it
 * buildable alone is what makes the merged listener a composition rather than a rewrite.
 */
export function createServer(deps: ServerDeps): Server {
  return mountRoutes(createRoutes(deps), deps);
}
