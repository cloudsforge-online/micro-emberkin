/**
 * The two route tables, measured against each other.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A COLLIDING PATH IS NOT AN ERROR. IT IS A ROUTE THAT SILENTLY STOPS BEING REACHABLE.**
 *
 * `mountRoutes` matches FIRST-WINS over a flat list, and the merged listener puts emberkin's table
 * first (`createMergedServer`). So any path both titles declare resolves to emberkin's handler and
 * aetherholm's copy is dead — no exception, no warning, no metric. `/livez` answering 200 from the
 * wrong module looks exactly like `/livez` answering 200 from the right one.
 *
 * Four paths collide today, and every one of them is deliberately dropped from what the aetherholm
 * module mounts (`aetherholm/module.ts`, `UNMOUNTED`):
 *
 *   `/livez`, `/readyz`, `/metrics`   one process serves one of each; emberkin's win, and
 *                                      `/readyz` reflects BOTH databases (see `merged.test.ts`).
 *   `POST /v1/events`                  one webhook for the process, which VERIFIES once and then
 *                                      FANS OUT. Both titles subscribe to `identity.user.deleted`;
 *                                      shadowing this one would be a deletion that answers 202
 *                                      while half of it never happened.
 *
 * This file exists so that a FIFTH collision — a route either title adds later — is a red build
 * rather than a route that quietly stops working. It computes the overlap rather than listing it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No database: `createRoutes` builds closures and queries nothing. This suite therefore runs in
 * the no-DSN case too, which is where a route-table regression is cheapest to catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { Logger, Metrics } from '@cloudsforge/telemetry';
import type { Lifecycle } from '@cloudsforge/lifecycle';
import { GameData } from './content/gamedata.ts';
import { createRoutes as emberkinRoutes, type ServerDeps as EmberkinDeps } from './routes.ts';
import { createRoutes as aetherholmRoutes, type ServerDeps as AetherholmDeps } from './aetherholm/routes.ts';
import { stripComments } from './aetherholm/testsupport.ts';
import { OPERATIONAL_ROUTES } from './kernel.ts';

/** A selector over a handle nothing dereferences. Route CONSTRUCTION issues no query. */
const stubSql = networkSql({ mainnet: {} as unknown as RuntimeSql });
const quiet = new Logger({ service: 'mergedroutes-test', sink: () => {} });
const stubLifecycle = {} as unknown as Lifecycle;
const verifier = { principal: async () => { throw new Error('not used'); } };

const emberkin = emberkinRoutes({
  lifecycle: stubLifecycle,
  logger: quiet,
  metrics: new Metrics(),
  verifier,
  sql: stubSql,
  singleNetwork: 'mainnet',
  producer: 'emberkin',
  data: GameData.loadFromDirectory(),
  billing: { entitlementsFor: async () => [] } as unknown as EmberkinDeps['billing'],
  queueFor: () => ({ enqueue: async () => undefined }) as unknown as ReturnType<EmberkinDeps['queueFor']>,
  eventAcceptSecrets: ['unused-by-construction'],
});

const aetherholm = aetherholmRoutes({
  lifecycle: stubLifecycle,
  logger: quiet,
  metrics: new Metrics(),
  verifier,
  sql: stubSql,
  singleNetwork: 'mainnet',
  producer: 'aetherholm',
  queue: { enqueue: async () => undefined } as unknown as AetherholmDeps['queue'],
  eventAcceptSecrets: ['unused-by-construction'],
});

const key = (spec: { method: string; path: string }): string => `${spec.method} ${spec.path}`;

/** The four the aetherholm module drops. Spelled here so the test states the contract itself. */
const EXPECTED_OVERLAP = ['GET /livez', 'GET /metrics', 'GET /readyz', 'POST /v1/events'];

describe('the two titles cannot shadow each other by accident', () => {
  it('is looking at two real route tables', () => {
    // Two empty arrays would satisfy every assertion below. This is what stops that.
    assert.ok(emberkin.length >= 8, `emberkin declares ${emberkin.length} routes`);
    assert.ok(aetherholm.length >= 30, `aetherholm declares ${aetherholm.length} routes`);
  });

  it('overlaps on EXACTLY the four paths the module drops, and nothing else', () => {
    const mine = new Set(emberkin.map(key));
    const overlap = aetherholm.map(key).filter((k) => mine.has(k)).sort();
    assert.deepEqual(
      overlap,
      EXPECTED_OVERLAP,
      'a path both titles declare resolves to emberkin and aetherholm’s copy is DEAD — first-wins, ' +
        'no error. If a fifth appeared, either rename it or add it to UNMOUNTED and give the ' +
        'aetherholm half a way to be reached, as POST /v1/events got one.',
    );
  });

  it('and every collision is one of the three operational paths or the shared webhook', () => {
    for (const k of EXPECTED_OVERLAP) {
      const path = k.slice(k.indexOf(' ') + 1);
      assert.ok(
        OPERATIONAL_ROUTES.has(path) || path === '/v1/events',
        `${k} collides for a reason this file has not written down`,
      );
    }
  });

  it('keeps the /v1/content/* families apart, which is the near-miss', () => {
    // emberkin serves `/v1/content/dex`; aetherholm serves `/v1/content/buildings`, `/research`
    // and `/airships`. Same prefix, four distinct literals — the kernel compiles whole segments,
    // so the prefix is not a collision. Asserted because it LOOKS like one.
    const content = [...emberkin, ...aetherholm].map((s) => s.path).filter((p) => p.startsWith('/v1/content/'));
    assert.equal(new Set(content).size, content.length, `duplicate content path: ${content.join(', ')}`);
    assert.ok(content.length >= 4, 'both titles must still be serving content reads');
  });
});

describe('only the aetherholm module may read the aetherholm module’s configuration', () => {
  /*
   * The M1 shape, applied to a DSN rather than to a pepper. `AETHERHOLM_DATABASE_URL` enters this
   * process in `aetherholm/module.ts`'s import graph and in no other — so `src/index.ts`, the
   * merged composition root, never holds a handle or a DSN of that module's and cannot pass one
   * anywhere. With six same-named tables between the two schemas, a handle passed to the wrong
   * half is a query that succeeds and says nothing.
   */
  /*
   * OVER COMMENT-STRIPPED SOURCE. `index.ts` and `migrator.ts` both EXPLAIN at length that they do
   * not import this file, and a raw scan reads those sentences as the violation — a guard that
   * fails on the documentation of the rule teaches people to delete the guard. Six estate guards
   * have fired on their own prose; `stripComments` is the same stripping the estate CI's Rule 1
   * does, and it caught this one on its first run.
   */
  const source = (dir: string, name: string): string =>
    stripComments(readFileSync(new URL(`${dir}${name}`, import.meta.url), 'utf8'));

  const importers = readdirSync(new URL('./aetherholm/', import.meta.url))
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => source('./aetherholm/', name).includes("from './env.ts'"))
    .sort();

  it('is imported by module.ts and by nothing else in the module', () => {
    assert.deepEqual(importers, ['module.ts']);
  });

  it('and by nothing at all outside it', () => {
    // ASSEMBLED rather than written, so this file does not contain the string it hunts for and
    // cannot report itself. The same reason `migratortargets.test.ts` assembles its DSNs.
    const needle = ['from ', "'./aetherholm/", "env.ts'"].join('');
    const outside = readdirSync(new URL('./', import.meta.url))
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => source('./', name).includes(needle))
      .sort();
    assert.deepEqual(outside, [], `${outside.join(', ')} reaches into the other module's configuration`);
  });

  it('and the detector is reading real files', () => {
    // A wrong directory would make both assertions above pass by finding nothing.
    const files = readdirSync(new URL('./aetherholm/', import.meta.url)).filter((n) => n.endsWith('.ts'));
    assert.ok(files.includes('env.ts') && files.includes('module.ts'), files.join(', '));
    assert.ok(files.length > 20, `only ${files.length} files — is this the right directory?`);
  });
});
