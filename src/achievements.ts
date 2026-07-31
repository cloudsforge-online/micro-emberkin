/**
 * The achievement bridge to the worlds shared profile.
 *
 * A Resonance milestone or dex completion is recorded locally (once, by the `player_achievements`
 * unique) inside the battle transaction. Delivery to worlds is a LEASED JOB, keyed by the
 * achievement id, so a worlds outage delays the badge rather than losing or doubling it, and two
 * workers cannot both deliver one achievement.
 */

import type { WorldsClient } from './worldsclient.ts';
import { WorldsRefusedError, WorldsUnavailableError } from './worldsclient.ts';
import { TITLE_SCOPE } from './cosmetics.ts';
import type { Logger } from '@cloudsforge/telemetry';
import type { Db } from './outbox.ts';

export interface AchievementDeps {
  readonly sql: Db;
  readonly worlds: WorldsClient;
  readonly logger: Logger;
}

interface AchievementRow {
  readonly id: string;
  readonly user_id: string;
  readonly code: string;
  readonly name: string;
  readonly points: number;
  readonly delivered_at: Date | null;
}

export type DeliverOutcome = 'delivered' | 'gone' | 'already' | 'refused';

/** The ids of achievements not yet delivered — the sweep enqueues a delivery per id. */
export async function outstandingAchievementIds(sql: Db, limit = 100): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from player_achievements where delivered_at is null order by unlocked_at limit ${limit}
  `;
  return rows.map((r) => r.id);
}

/**
 * Deliver one achievement to worlds. Returns a terminal outcome; throws only on an outage, so the
 * job runner reschedules the delivery with backoff and the SAME idempotency key.
 */
export async function deliverAchievement(deps: AchievementDeps, achievementId: string, correlationId: string): Promise<DeliverOutcome> {
  const rows = await deps.sql<AchievementRow[]>`
    select id, user_id, code, name, points, delivered_at from player_achievements where id = ${achievementId}
  `;
  const row = rows[0];
  if (!row) return 'gone';
  if (row.delivered_at) return 'already';

  try {
    await deps.worlds.postAchievement({
      userId: row.user_id,
      titleSlug: TITLE_SCOPE,
      code: row.code,
      name: row.name,
      points: row.points,
      correlationId,
      // Derived from (user, code): a redelivery posts once.
      idempotencyKey: `emberkin:achievement:${row.user_id}:${row.code}`,
    });
  } catch (err) {
    if (err instanceof WorldsUnavailableError) throw err; // retry with backoff
    if (err instanceof WorldsRefusedError) {
      deps.logger.warn('worlds refused an achievement permanently', { achievementId, err: err.message });
      return 'refused';
    }
    throw err;
  }

  // Mark delivered only after worlds accepted it. The guard makes a re-run idempotent.
  await deps.sql`update player_achievements set delivered_at = now() where id = ${achievementId} and delivered_at is null`;
  return 'delivered';
}
