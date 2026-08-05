/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * What this schema owns: the authoritative game save (progress, party, inventory, catches, the
 * per-Kin Resonance/Temperament/Sync state that lives inside each party member), recorded battle
 * sessions (so a battle resolves server-side from a seed and a retry replays), player achievements
 * bridged to worlds, and seasons whose rewards are budget-capped ledger postings.
 *
 * **There is deliberately no balance/shards column anywhere.** A cosmetic purchase is a billing
 * entitlement plus a ledger posting; this service records the equip, never a balance. That is the
 * "service holds no money" rule expressed as an absence you can grep for.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs';
import type { Migration } from '@cloudsforge/db';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Verbatim from the runtime package so the claim query's table and the table that exists
    // cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run — a
      -- re-granted season pass must not pay a reward twice.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'saves',
    up: `
      create table if not exists saves (
        user_id            uuid          primary key,
        warden_name        text          not null,
        -- The campaign seed (a C#-compatible ulong). Every wild encounter and every battle is
        -- resolved deterministically from it server-side, which is also what enables async PvP.
        seed               numeric(20,0) not null,
        current_region     text          not null,
        story_progress     integer       not null default 0,
        playtime_seconds   bigint        not null default 0,
        -- Party and box are arrays of KinSave (see src/engine/saves.ts) — each carries its own
        -- Resonance, Temperament and per-instance Attunement. The client is NOT authoritative.
        party              jsonb         not null default '[]'::jsonb,
        box                jsonb         not null default '[]'::jsonb,
        inventory          jsonb         not null default '{}'::jsonb,
        seals              jsonb         not null default '[]'::jsonb,
        dex_seen           jsonb         not null default '[]'::jsonb,
        -- Cosmetics are keyed by slot. Setting one is gated by a billing entitlement; NONE of this
        -- ever touches a stat — that is the anti-pay-to-win line.
        equipped_cosmetics jsonb         not null default '{}'::jsonb,
        save_version       integer       not null default 1,
        created_at         timestamptz   not null default now(),
        updated_at         timestamptz   not null default now(),
        constraint saves_warden_name_length check (char_length(warden_name) between 1 and 40),
        constraint saves_story_progress_non_negative check (story_progress >= 0),
        constraint saves_playtime_non_negative check (playtime_seconds >= 0),
        -- A ulong. Constrained so a seed cannot silently exceed the range the C# RNG is defined on.
        constraint saves_seed_range check (seed >= 0 and seed <= 18446744073709551615)
      );
    `,
  },
  {
    version: 5,
    name: 'battles',
    up: `
      create table if not exists battles (
        id              uuid          primary key default gen_random_uuid(),
        user_id         uuid          not null references saves (user_id) on delete cascade,
        seed            numeric(20,0) not null,
        -- The full battle spec (parties + scripted actions) and the resolved log/outcome. The log
        -- is the same one the C# reference produces for this seed — replayable, spectatable.
        spec            jsonb         not null,
        outcome         text          not null,
        turns           integer       not null default 0,
        log             jsonb         not null default '[]'::jsonb,
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **THE IDEMPOTENCY OF A BATTLE SUBMISSION.** Derived from the client's Idempotency-Key,
        -- fingerprinting the request body but EXCLUDING per-attempt fields like correlationId, so
        -- two attempts at one battle replay the same recorded row rather than resolving — and
        -- double-applying — a second battle. Backed by the unique index below.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        idempotency_key text          not null,
        created_at      timestamptz   not null default now(),
        constraint battles_key_uniq unique (user_id, idempotency_key),
        constraint battles_outcome_known check (
          outcome in ('Ongoing','PlayerWin','EnemyWin','Caught','Fled')
        ),
        constraint battles_turns_non_negative check (turns >= 0)
      );

      create index if not exists battles_user_idx on battles (user_id, created_at desc);
    `,
  },
  {
    version: 6,
    name: 'player_achievements',
    up: `
      create table if not exists player_achievements (
        id           uuid        primary key default gen_random_uuid(),
        user_id      uuid        not null,
        code         text        not null,
        name         text        not null,
        points       integer     not null default 0,
        unlocked_at  timestamptz not null default now(),
        -- Null until the leased delivery job has posted it to the worlds shared profile.
        delivered_at timestamptz,
        -- The unique IS the idempotency: an achievement unlocks once per account, and a tick that
        -- re-evaluates it conflicts rather than delivering twice.
        constraint player_achievements_uniq unique (user_id, code),
        constraint player_achievements_points_sane check (points between 0 and 1000)
      );

      create index if not exists player_achievements_undelivered_idx
        on player_achievements (unlocked_at)
        where delivered_at is null;
    `,
  },
  {
    version: 7,
    name: 'seasons',
    up: `
      create table if not exists seasons (
        id                     uuid          primary key default gen_random_uuid(),
        slug                   text          not null,
        name                   text          not null,
        starts_at              timestamptz   not null,
        ends_at                timestamptz   not null,
        status                 text          not null default 'upcoming',
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **THE BUDGET CAP.** Season rewards are ledger postings, so a game exploit that mints
        -- rewards is a money incident. The cap is enforced by the database, in the same
        -- transaction as the grant, so no application-level cleverness can spend past it.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        reward_budget_shards   numeric(78,0) not null,
        rewards_granted_shards numeric(78,0) not null default 0,
        created_at             timestamptz   not null default now(),
        updated_at             timestamptz   not null default now(),
        constraint seasons_slug_uniq unique (slug),
        constraint seasons_status_known check (status in ('upcoming','active','ended','archived')),
        constraint seasons_dates_ordered check (ends_at > starts_at),
        constraint seasons_budget_positive check (reward_budget_shards > 0),
        constraint seasons_within_budget check (
          rewards_granted_shards >= 0 and rewards_granted_shards <= reward_budget_shards
        )
      );

      create table if not exists reward_grants (
        id               uuid          primary key default gen_random_uuid(),
        season_id        uuid          not null references seasons (id) on delete cascade,
        user_id          uuid          not null,
        reason           text          not null,
        amount_shards    numeric(78,0) not null,
        -- The ledger entry that paid it. NOT NULL: a reward with no entry is a payment that exists
        -- only in this service's opinion.
        journal_entry_id text          not null,
        -- Derived from (season, user, reason), so a retry that lands twice pays once.
        idempotency_key  text          not null,
        granted_at       timestamptz   not null default now(),
        constraint reward_grants_key_uniq unique (idempotency_key),
        constraint reward_grants_amount_positive check (amount_shards > 0)
      );

      create index if not exists reward_grants_season_idx on reward_grants (season_id, granted_at desc);
    `,
  },
  {
    version: 8,
    name: 'erasure',
    up: `
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      -- **RIGHT TO ERASURE, AND THE ONE ROW THAT SURVIVES IT.**
      --
      -- Rule 6 of docs/ecosystem/03 §2: a service storing a \`user_id\` subscribes to
      -- \`identity.user.deleted\` and erases. \`saves\` (and \`battles\` by cascade) and
      -- \`player_achievements\` are simply deleted — see the table in src/erasure.ts. A
      -- \`reward_grants\` row is NOT: it is the local record of a ledger posting that moved real
      -- money, and \`seasons.rewards_granted_shards\` is the sum it must continue to reconcile
      -- against. So the row is kept and its \`user_id\` is overwritten with a RANDOM uuid.
      --
      -- A random uuid in a \`uuid not null\` column is indistinguishable from a real account, which
      -- is what these three objects fix:
      --
      --   \`user_erased_at\`  — non-null marks the row anonymised. Distinguishable, queryable,
      --                       auditable: "how many grants belong to nobody" is now a query.
      --   the CHECK        — an erased row's \`idempotency_key\` must carry the erased form.
      --                       The key WAS \`emberkin:reward:<season>:<user>:<reason>\`, i.e. the
      --                       user id in plain text (src/ledgerclient.ts:144), so anonymising the
      --                       column alone would have left the id sitting in the row beside it.
      --   the trigger      — erasure is ONE-WAY. An anonymised row can never be re-attributed to
      --                       a person, by this service or by anything holding a psql prompt.
      -- ══════════════════════════════════════════════════════════════════════════════════════════
      alter table reward_grants add column if not exists user_erased_at timestamptz;

      create index if not exists reward_grants_erased_idx
        on reward_grants (user_erased_at)
        where user_erased_at is not null;

      alter table reward_grants drop constraint if exists reward_grants_erased_key_form;
      alter table reward_grants add constraint reward_grants_erased_key_form check (
        user_erased_at is null
        or idempotency_key ~ '^emberkin:reward:erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      );

      create or replace function reward_grants_erasure_is_one_way() returns trigger
      language plpgsql as $$
      begin
        if old.user_erased_at is not null then
          if new.user_id is distinct from old.user_id then
            raise exception 'reward_grants: an erased grant cannot be re-attributed to a person (grant %)', old.id;
          end if;
          if new.user_erased_at is null then
            raise exception 'reward_grants: an erasure cannot be undone (grant %)', old.id;
          end if;
        end if;
        return new;
      end;
      $$;

      drop trigger if exists reward_grants_one_way_erasure on reward_grants;
      create trigger reward_grants_one_way_erasure
        before update on reward_grants
        for each row execute function reward_grants_erasure_is_one_way();
    `,
  },
];

/** The version this build requires. `index.ts` asserts it at boot and refuses to serve below it. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** A new service leaves this at 0 — the frozen kindred-resonance C# save is a data copy, not a baseline. */
export const BASELINE_VERSION = 0;

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'reward_grants',
  'seasons',
  'player_achievements',
  'battles',
  'saves',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
]);
