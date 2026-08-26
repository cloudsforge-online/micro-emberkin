/**
 * How the two titles' job planes compose, and the collision that forces it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOTH TITLES REGISTER A JOB KIND CALLED `outbox.relay`. EXACTLY THAT STRING.**
 *
 * Measured below rather than asserted from memory. It matters twice over:
 *
 *   1. **One shared runner cannot hold both.** `@cloudsforge/jobs`' `register()` throws
 *      `handler already registered for outbox.relay` on the duplicate. That is a GOOD failure —
 *      loud, at boot, naming the kind — and this file keeps it provable so nobody "fixes" it by
 *      making registration idempotent, which would silently drop one title's relay.
 *
 *      It is also not the arrangement this process could have used even if the kinds were
 *      disjoint: a `JobRunner` binds to one `JobQueue`, which binds to one `sql` handle, which is
 *      one database. Two databases, two runners. Forced, not chosen.
 *
 *   2. **The SILENT shape is the one next door.** emberkin already runs one runner per network
 *      plane, so "just add another runner" is the natural move — and N runners all counting
 *      `kind="outbox.relay"` into ONE unlabelled registry produce ONE series that still moves.
 *      Nothing errors. An alert on `jobs_failed_total{kind="outbox.relay"}` fires on the sum of
 *      two unrelated relays and names a service that is now two titles.
 *
 *      `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all:
 *      one module's sample OVERWRITES the other's on every scrape, so a wedged queue is ABSENT
 *      from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s
 *      `JobQueueOverdue` alerts on exactly that gauge. aetherholm wrote them with NO labels;
 *      emberkin wrote them with `network` only, which does not distinguish it from aetherholm
 *      either.
 *
 * So: separate runners, and every job metric through `metrics.withLabels({ module })`
 * (micro-runtime#9). The last two cases below are the ones that go red if the label is removed —
 * they compare a labelled arrangement against the unlabelled one and require them to DIFFER.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No database: `JobQueue` and `JobRunner` issue no query at construction, and `register` is a map
 * insert. This suite therefore runs in the no-DSN case, which is where a composition regression is
 * cheapest to catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import { Logger, Metrics, registerJobMetrics } from '@cloudsforge/telemetry';
import {
  RELAY_KIND as EMBERKIN_RELAY,
  SEASON_ROLLOVER_KIND,
  SEASON_REWARD_KIND,
  registerHandlers as registerEmberkinHandlers,
  type JobDeps as EmberkinJobDeps,
} from './jobs.ts';
import {
  RELAY_KIND as AETHERHOLM_RELAY,
  SEASON_ENSURE_KIND,
  SEASON_CLOSE_KIND,
  registerHandlers as registerAetherholmHandlers,
  type JobDeps as AetherholmJobDeps,
} from './aetherholm/jobs.ts';

const quiet = new Logger({ service: 'jobcomposition-test', sink: () => {} });
const nothing = {} as unknown as JobsSql;
const queue = (): JobQueue => new JobQueue(nothing, { owner: 'jobcomposition-test', leaseMs: 1_000 });
const runner = (): JobRunner => new JobRunner({ queue: queue(), pollMs: 60_000 });

function emberkinDeps(metrics: Metrics): EmberkinJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    worlds: {} as EmberkinJobDeps['worlds'],
    ledger: {} as EmberkinJobDeps['ledger'],
    producer: 'emberkin',
    signingSecret: 'not-used-by-registration',
    seasonBudgetWei: 0n,
    queue: { enqueue: async () => undefined } as unknown as EmberkinJobDeps['queue'],
  };
}

function aetherholmDeps(metrics: Metrics): AetherholmJobDeps {
  return {
    sql: nothing as never,
    logger: quiet,
    metrics,
    producer: 'aetherholm',
    signingSecret: 'not-used-by-registration',
    queue: { enqueue: async () => undefined } as unknown as AetherholmJobDeps['queue'],
  };
}

describe('the kind collision is real', () => {
  it('both titles name their relay `outbox.relay`, character for character', () => {
    assert.equal(EMBERKIN_RELAY, 'outbox.relay');
    assert.equal(AETHERHOLM_RELAY, 'outbox.relay');
    assert.equal(EMBERKIN_RELAY, AETHERHOLM_RELAY);
  });

  it('and the season family is a NEAR miss, which is worth writing down', () => {
    /*
     * `season.rollover` and `season.reward` are emberkin's; `season.ensure` and `season.close` are
     * aetherholm's. Four distinct strings, so `jobs_failed_total{kind=…}` separates them today and
     * nothing sums them.
     *
     * What WOULD sum them is a rule matching `kind=~"season\..*"`, which is a natural thing to
     * write and would quietly add two titles' seasons together. No such rule exists in
     * `deploy/prometheus/rules/*.yaml` as of this change — checked, zero matches for `season`.
     * This case exists so the next person to write one finds the `module` label first.
     */
    const family = [SEASON_ROLLOVER_KIND, SEASON_REWARD_KIND, SEASON_ENSURE_KIND, SEASON_CLOSE_KIND];
    assert.equal(new Set(family).size, 4, `season kinds must stay distinct: ${family.join(', ')}`);
    for (const kind of family) assert.match(kind, /^season\./, `${kind} would escape a season.* matcher`);
  });
});

describe('one shared runner is refused, loudly, at boot', () => {
  it('throws naming the kind rather than silently keeping one relay', () => {
    const metrics = registerJobMetrics(new Metrics());
    const shared = runner();
    registerEmberkinHandlers(shared, emberkinDeps(metrics));
    assert.throws(
      () => registerAetherholmHandlers(shared, aetherholmDeps(metrics)),
      /handler already registered for outbox\.relay/,
      'the duplicate must be refused. A registration that overwrote, or that no-op’d, would leave ' +
        'one title’s outbox undelivered with nothing anywhere saying so.',
    );
  });

  it('while two runners each take their own set without complaint', () => {
    // The arrangement this process actually runs — and it is forced: a runner binds to one queue,
    // which binds to one handle, which is one database.
    const metrics = registerJobMetrics(new Metrics());
    assert.doesNotThrow(() => registerEmberkinHandlers(runner(), emberkinDeps(metrics)));
    assert.doesNotThrow(() => registerAetherholmHandlers(runner(), aetherholmDeps(metrics)));
  });
});

describe('separate runners are only READABLE because of the module label', () => {
  const render = (metrics: Metrics): string[] => metrics.render().split('\n');

  it('WITHOUT it, two relays are one series — the failure this pins', () => {
    // The shape a careless merge produces: two runners, one registry, no module label. It does not
    // error. It produces a number that moves and cannot be attributed.
    const metrics = registerJobMetrics(new Metrics());
    metrics.increment('jobs_failed_total', { kind: EMBERKIN_RELAY });
    metrics.increment('jobs_failed_total', { kind: AETHERHOLM_RELAY });

    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'));
    assert.equal(relays.length, 1, 'two unlabelled runners collapse into one series');
    assert.match(relays[0] ?? '', / 2$/, 'and the value is the SUM of two unrelated relays');
  });

  it('WITH it, they are two series and each counts only its own', () => {
    const metrics = registerJobMetrics(new Metrics());
    metrics.withLabels({ module: 'emberkin' }).increment('jobs_failed_total', { kind: EMBERKIN_RELAY });
    metrics.withLabels({ module: 'aetherholm' }).increment('jobs_failed_total', { kind: AETHERHOLM_RELAY });

    const relays = render(metrics).filter((l) => l.startsWith('jobs_failed_total{') && l.includes('outbox.relay'));
    assert.equal(relays.length, 2, `two modules' relays must be two series:\n${relays.join('\n')}`);
    assert.ok(relays.some((l) => l.includes('module="emberkin"')));
    assert.ok(relays.some((l) => l.includes('module="aetherholm"')));
    for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum');
  });

  it('and the unlabelled gauges ERASE each other, which is why beforeScrape uses the view', () => {
    /*
     * `jobs_pending` and `jobs_overdue` carry no `kind`. This is the same registry sampled by two
     * modules, unlabelled — the second `set` does not add, it REPLACES. A wedged aetherholm queue
     * would then not be "high" on the graph; it would be absent, and `JobQueueOverdue` would read
     * emberkin's zero.
     */
    const unlabelled = registerJobMetrics(new Metrics());
    unlabelled.set('jobs_pending', 41);
    unlabelled.set('jobs_pending', 0);
    const erased = render(unlabelled).filter((l) => l.startsWith('jobs_pending'));
    assert.equal(erased.length, 1);
    assert.match(erased[0] ?? '', / 0$/, 'the healthy sample erased the wedged one');

    const labelled = registerJobMetrics(new Metrics());
    labelled.withLabels({ module: 'aetherholm' }).set('jobs_pending', 41);
    labelled.withLabels({ module: 'emberkin' }).set('jobs_pending', 0, { network: 'mainnet' });
    const kept = render(labelled).filter((l) => l.startsWith('jobs_pending'));
    assert.equal(kept.length, 2, `both modules' depths must survive one scrape:\n${kept.join('\n')}`);
    assert.ok(kept.some((l) => l.includes('module="aetherholm"') && / 41$/.test(l)), kept.join('\n'));
  });
});
