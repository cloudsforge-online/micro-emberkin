// Schema tests. Prove the migrations apply to SCHEMA_VERSION, every owned table exists, and the
// CHECK constraints actually fire — by inserting the illegal row and matching the constraint name
// in the error.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts';
import { enabled, skip, openDb, migrateTestDb, resetEmberkin } from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb();
  await migrateTestDb(sql);
  await resetEmberkin(sql);
});

after(async () => {
  if (sql) await sql.end();
});

test('migrations: applied up to SCHEMA_VERSION', { skip }, async () => {
  const rows = await sql<{ v: number }[]>`select max(version)::int as v from schema_migrations`;
  assert.equal(rows[0]!.v, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test('migrations: every owned table exists', { skip }, async () => {
  for (const table of TABLES) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_name = ${table}
    `;
    assert.equal(rows[0]!.n, 1, `table ${table} is missing`);
  }
});

test('migrations: the saves seed range constraint fires', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into saves (user_id, warden_name, seed, current_region) values (gen_random_uuid(), 'W', -1, 'r')`,
    /saves_seed_range/,
  );
});

test('migrations: the warden name length constraint fires', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into saves (user_id, warden_name, seed, current_region) values (gen_random_uuid(), '', 1, 'r')`,
    /saves_warden_name_length/,
  );
});

test('migrations: the battles outcome constraint fires', { skip }, async () => {
  const u = '11111111-1111-4111-8111-111111111111';
  await sql`insert into saves (user_id, warden_name, seed, current_region) values (${u}, 'W', 1, 'r')`;
  await assert.rejects(
    () => sql`insert into battles (user_id, seed, spec, outcome, idempotency_key) values (${u}, 1, '{}', 'Nonsense', 'k')`,
    /battles_outcome_known/,
  );
  await resetEmberkin(sql);
});

test('migrations: a battle idempotency key is unique per user', { skip }, async () => {
  const u = '22222222-2222-4222-8222-222222222222';
  await sql`insert into saves (user_id, warden_name, seed, current_region) values (${u}, 'W', 1, 'r')`;
  await sql`insert into battles (user_id, seed, spec, outcome, idempotency_key) values (${u}, 1, '{}', 'PlayerWin', 'dup')`;
  await assert.rejects(
    () => sql`insert into battles (user_id, seed, spec, outcome, idempotency_key) values (${u}, 1, '{}', 'PlayerWin', 'dup')`,
    /battles_key_uniq/,
  );
  await resetEmberkin(sql);
});

test('migrations: the season budget-cap constraint fires', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into seasons (slug, name, starts_at, ends_at, reward_budget_shards, rewards_granted_shards)
      values ('s1', 'S', now(), now() + interval '30 days', 100, 200)
    `,
    /seasons_within_budget/,
  );
});

test('migrations: an achievement unlocks once per account', { skip }, async () => {
  const u = '33333333-3333-4333-8333-333333333333';
  await sql`insert into player_achievements (user_id, code, name) values (${u}, 'x', 'X')`;
  await assert.rejects(
    () => sql`insert into player_achievements (user_id, code, name) values (${u}, 'x', 'X')`,
    /player_achievements_uniq/,
  );
  await resetEmberkin(sql);
});

test('migrations: there is no money/balance column anywhere (service holds no money)', { skip }, async () => {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
       and (column_name like '%balance%' or column_name = 'shards' or column_name like '%_balance%')
  `;
  assert.equal(rows.length, 0, `unexpected balance column: ${JSON.stringify(rows)}`);
});
