# micro-emberkin

[![ci](https://github.com/cloudsforge-online/micro-emberkin/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-emberkin/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

**Emberkin** (subtitle *Resonance*) — the second Forge Worlds title. A monster-collecting RPG whose
battle core, content and signature bond system are a behavioural port of
[`kindred-resonance`](https://github.com/savvaniss/kindred-resonance) (KINDRED: Resonance), brought
inside the CloudsForge estate onto worlds, billing, identity and the ledger — without its gameplay
being colonised by the platform.

Design authority: [`ecosystem/19-new-products.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/19-new-products.md)

This repository is the **game service**: authoritative saves, the deterministic battle engine as a
TypeScript module, content as canonical JSON with schema tests, and the worlds/billing/ledger
integration. The Three.js client (`micro-emberkin-web`) is a separate, later repository.

## What it is

- **A deterministic battle engine**, ported from the C# `Kindred.Core`. It is seed-driven: the same
  seed and the same inputs produce a byte-identical battle log. That is what lets a battle resolve
  server-side (the client is not authoritative), and what enables the async-PvP extension later.
- **Authoritative saves in Postgres** — campaign progress, party, inventory, catches, and the
  per-Kin **Resonance / Temperament / Sync** state that lives inside each party member.
- **Content as data with tests** — 50 species, 47 moves, a 9-element type chart, 6 regions. Every
  learnset move exists, every evolution target exists, every species has a type and a visual spec.
- **Worlds integration** — Resonance milestones and dex completion become shared-profile
  achievements (a leased delivery job), monetisation is cosmetics + season passes as **billing
  entitlements** (never stat advantage), and a season's rewards are **budget-capped ledger
  postings denominated in EMBER**. This service holds no money and has no balance column.

## What it ports from kindred-resonance, and the rebrand

The port is **behavioural, not textual**: the C# core is the reference implementation and the
TypeScript port must replay a recorded corpus of battles seed-for-seed and match outcomes exactly.

| Ported from `kindred-resonance` | To |
| --- | --- |
| `src/Kindred.Core/Rng.cs` (xorshift128+ / SplitMix64) | `src/engine/rng.ts` — reproduced bit-for-bit over 64-bit BigInt |
| `Battle/BattleEngine.cs`, `DamageCalculator.cs`, `TypeChart.cs`, `Catching.cs` | `src/engine/*.ts` |
| `Kin.cs`, `Party.cs`, `Items.cs`, `Enums.cs`, `Content/*`, `Save/SaveGame.cs` | `src/engine/*.ts`, `src/content/*.ts` |
| `content/*.json` (species, moves, types, campaign, visuals) | `content/*.json` (verbatim) |
| `tests/Kindred.Core.Tests` | `src/engine.test.ts`, `src/content.test.ts` |

The rebrand is **lore-only**; the game was already accidentally set in the CloudsForge universe:

| In the game | In the estate |
| --- | --- |
| The world's floating **shards** | Nothing. Scenery, and only scenery — see below |
| The **ember** type / Cindercub of *Emberfall Vale* | The chain token **EMBER**, the **Hearth** chain |
| **Aether**, the binding energy | The network the platform runs on |

That row used to read "the internal currency, **Shards**", and the equation was wrong in both
directions. In the game, shards are cosmology and a story item (`relic_shard`, `ice_shard`) — they
are not a balance, nothing is priced in them and nothing pays out in them. In the estate, **SHARD
is a retired asset**: not issuable, minted by nothing, and being drained. Mapping the two invited a
reader to think the game earns a currency they could go and acquire, when neither half of that is
true. The shared word is a coincidence of vocabulary and stays one.

The estate half of that separation is now finished too. Until micro-org#226 this service's season
budgets and reward grants really were denominated in SHARD — the retired asset — while the
programme funding them is EMBER. Migration 9 converted the columns (`reward_budget_wei`,
`rewards_granted_wei`, `amount_wei`) and both ledger legs moved with them. See
**Season rewards** below.

- **Title: Emberkin** (subtitle *Resonance* kept — it names the signature system).
- **Kin, Wardens, Resonance, Temperament, Sync** are kept verbatim — the bond system is the product.
- **No gameplay value on-chain, no Kin-as-NFT, no pay-to-win.** The only content string changed is
  the campaign title (`KINDRED: Resonance` → `Emberkin: Resonance`); every mechanic name is untouched.

## The conformance discipline

`src/fixtures/rng-reference.json` and `src/fixtures/corpus.json` were **generated by running the
upstream C# itself** (a harness that project-references `Kindred.Core` without modifying it):

- `src/rng.test.ts` asserts the port reproduces the C# `NextDouble()` **bit-for-bit** across 8 seeds.
- `src/conformance.test.ts` replays 10 recorded battles — covering crit, STAB, type effectiveness,
  Resonance Arts (spent and the free-at-Perfect path), status, catching, fleeing, switching, item
  use and every outcome — and asserts the log is **byte-identical** to the C#.

If the RNG ever drifts, the corpus fails the build.

## What it talks to

- **identity** — token verification (JWKS), and the **service-token exchange** that authenticates
  the three calls below.
- **billing** — reads what an account owns, to gate a cosmetic equip (`billing:read`).
- **ledger** — posts a season reward in **EMBER** (`ledger:post`); the service keeps no balance.
- **worlds** — posts achievements to the shared profile (`worlds:write`).

### How the outbound calls authenticate

All three present a **short-lived** bearer, and this service holds a **long-lived credential**
(`EMBERKIN_IDENTITY_CREDENTIAL`, a `cfsc_…` value) rather than a token. `src/upstreams.ts` exchanges
it at identity's `POST /service-tokens/exchange` and re-mints **before** the token expires, at a
jittered fraction of whatever `expiresIn` that exchange answered with — the issuer owns that number,
so a copy of it here would be a second source of truth waiting to drift. Refresh is driven by
traffic, not a timer, and a refresh already in flight is shared rather than repeated.

This replaces the defect in **micro-org #228**: the composition root used to read a **ten-minute
token** once at boot and present it verbatim for the life of the process, so a replica authenticated
for its first ten minutes and presented a dead token afterwards — with `/livez` green throughout,
because `/livez` verifies nothing. A longer expiry was never the fix: expiry *is* the rotation.

A refresh that fails is never presented as success. While a still-valid token is held the failure is
a `warn` and callers see nothing; once there is no usable token, outbound calls raise the
`…UnavailableError` class for their peer, which maps to **503, never 401** — "identity is
unreachable" and "you are not allowed" are different answers and an operator has to be able to tell
them apart. `emberkin_service_token_usable` reads 0 in exactly that state.

`EMBERKIN_SERVICE_TOKEN` is still accepted so a container mid-rollout keeps booting, but it is a
migration aid: the service logs `fatal` at boot while it is in use and
`emberkin_service_token_static` reads 1. Exactly one of the two must be set.

Outbound state changes go through a Postgres **outbox → signed HTTP → inbox** (deduped on the source
event id); the inbound `POST /v1/events` webhook is signature-checked before it is parsed. All
background work — the relay, achievement delivery, season rollover, the season welcome reward — is a
**leased job** claimed `FOR UPDATE SKIP LOCKED`; there is no `setInterval`.

### Event signatures

The scheme is **`@cloudsforge/contracts-events`'**, imported rather than copied:
`cf-signature: t=<seconds>,v1=<hmac over "<seconds>.<body>">`. This file used to carry a local copy
that signed `sha256=<hmac over the body>` under `x-cloudsforge-signature`, which nothing in the
estate sends or accepts — so every inbound delivery answered `403 bad_signature` (measured on a live
estate: one account deletion, 358 relay retries, a green `/livez` throughout) and every event this
service emitted was refused by its consumers for the mirror-image reason. Both directions moved.

Inbound verification has a **second, legacy arm**, and it is deliberate: this service's two
producers are on two schemes. `identity` sends the contract's signature; `billing` still sends the
legacy one (`billing/src/outbox.ts`, on purpose — "moving the producer half is a coordinated
change across those consumers"). Verifying only the contract's way would fix erasure and break the
season pass in the same commit. `emberkin_events_accepted_total{scheme="legacy"}` reaching zero is
what says billing has migrated and the arm can be deleted; `outbox.test.ts` pins it until then.

| Variable | Default | Notes |
| --- | --- | --- |
| `OUTBOX_SIGNING_SECRET` | — | **required, ≥24 chars, a single key.** Signs what this service emits. It stays one value: signing under two keys at once is not a rotation, it is a fork, and it doubles every subscriber's verification work. |
| `OUTBOX_ACCEPT_SECRETS` | `[OUTBOX_SIGNING_SECRET]` | Comma-separated, **newest first** — every key an inbound delivery may have been signed with, under *both* arms. A list rather than a value because the estate's outbox key is one secret shared by 24 services, and swapping it partitions delivery: whichever end moves first has everything between them refused until the other catches up. So the rotation is a window — add the new key at the front, restart, move the producers, then drop the old one. Unset it is today's behaviour byte for byte, which is what lets the estate rotate one service at a time rather than on a flag day. Each entry faces the signing secret's bar, and a repeat is refused at boot. |

## Running it

```bash
pnpm install
pnpm typecheck
pnpm verify        # engine demo: play a battle from a seed, no DB needed

# The full suite runs against a real Postgres (deferred constraints, leases, advisory locks) —
# and against TWO DATABASES, because this deployable is two titles. `src/merged.test.ts` needs
# both at once; each title's own suite needs only its own.
docker run -d --rm --name emberkin-pg -e POSTGRES_USER=emberkin -e POSTGRES_PASSWORD=emberkin \
  -e POSTGRES_DB=emberkin_test -p 55440:5432 postgres:17-alpine
PGPASSWORD=emberkin psql -h 127.0.0.1 -p 55440 -U emberkin -d emberkin_test \
  -c 'create database aetherholm_test'
EMBERKIN_TEST_DATABASE_URL=postgres://emberkin:emberkin@127.0.0.1:55440/emberkin_test \
AETHERHOLM_TEST_DATABASE_URL=postgres://emberkin:emberkin@127.0.0.1:55440/aetherholm_test \
  pnpm test
```

Migrations are a separate one-shot (`pnpm migrate`), never run at boot; it migrates **both**
databases in one process and refuses to start if the two DSNs address the same one. `index.ts`
asserts the schema version and refuses to serve below it. Copy `.env.example` to `.env` for local
work.

## One process, two titles (wave M3)

Since wave M3 of micro-deploy `docs/service-merge-plan.md` this deployable also runs
**Aetherholm** — the sky-island strategy title — as a module under `src/aetherholm/`. One image,
one listener, one `/livez`, one `/readyz`, one `/metrics`, one migrate entrypoint.

Emberkin absorbs on the **upstream** argument rather than on size (aetherholm is the larger at 7.6k
vs 6.9k LOC): this service already integrates ledger, billing, worlds and identity and holds a
service credential, while aetherholm calls nothing at all. Folding the zero-upstream side into the
four-upstream side does not widen the four-upstream side's reach; the reverse would have handed a
title with no outbound calls a credential that can post to the ledger.

**The two databases are kept and never merged**, under their existing `EMBERKIN_DATABASE_URL` and
`AETHERHOLM_DATABASE_URL`. That is not caution — the two schemas own **six tables of the same
name** (`outbox`, `event_subscriptions`, `outbox_deliveries`, `inbox`, `seasons`, `battles`), so a
handler on the wrong handle does not fail: `select … from seasons` succeeds and returns another
game's rows. Four things keep them apart, each of which fails on its own:

| | |
| --- | --- |
| `RouteSpec.sql` (`src/kernel.ts`) | a route names the SELECTOR its `ctx.sql` comes from; the kernel resolves it at the edge of the request, beside the network |
| closures, not a `deps` parameter | each module's handlers close over their own bag, so no route can reach the other's queue or producer |
| `aetherholm/env.ts` | imported by `aetherholm/module.ts` and nothing else, so the composition root never holds that module's DSN |
| `assertDistinct` (`src/migratortargets.ts`) | the migrator refuses two modules pointed at one database before it issues a statement |

**One webhook, fanned out.** Both titles subscribe to `identity.user.deleted`. `POST /v1/events`
verifies the MAC once — both read the same estate-wide `OUTBOX_SIGNING_SECRET` — and then delivers
to every module that subscribes, each against its own database and its own `inbox`. Routing it to
one module would answer 202 to a deletion half of which never happened, and nothing would retry
because nothing failed.

**Job metrics carry a `module` label.** Both titles register a job kind called `outbox.relay`,
exactly; `jobs_pending` and `jobs_overdue` carry no kind at all. Without the label one module's
sample erases the other's every scrape, and a wedged queue reads as *absent* rather than high.

`src/merged.test.ts` drives the whole of it over a real socket against both databases; each title's
own suite still drives its own listener alone and passes unchanged.

## HTTP surface

- `GET /livez` · `GET /readyz` · `GET /metrics`
- `POST /v1/events` — signed inbound webhook. Two topics: `billing.entitlement.granted`
  (season-pass grant → leased reward job) and `identity.user.deleted` (erasure — see below). Any
  other topic is 202'd and ignored; a bad signature is **403**, checked before the body is parsed —
  not 401, because the MAC is the credential and there is no token for a caller to go and find.
- `POST /v1/saves` — start a game (idempotent per account) · `GET /v1/saves/me`
- `POST /v1/saves/me/battles` — resolve a battle server-side; idempotent on `Idempotency-Key`
- `PUT /v1/saves/me/cosmetics` — equip a cosmetic, gated by a billing entitlement, never a stat
- `GET /v1/saves/me/achievements` · `GET /v1/content/dex`

Aetherholm's surface is served on the same listener and documented in its own repository: the title
contract (`GET /v1/title`, `POST /v1/provision`) plus city, fleet, alliance and chronicle play under
`/v1/`. The two path sets are disjoint apart from the three operational routes and the shared
webhook, and `src/mergedroutes.test.ts` fails if a fifth collision ever appears — a colliding path
is not an error, it is a route that silently stops being reachable.

## Season rewards

A season reward is a **ledger posting**, not a column: a game exploit that mints rewards is a money
incident reconciled against the ledger, rather than a number that appeared in a save row. Two legs,
balanced by construction — `engagement:emberkin` / `treasury` / `equity` on the debit side, the
player's `available` / `liability` on the credit side.

**Both legs are EMBER, and both were SHARD until micro-org#226.** The programme is funded in EMBER
(`docs/ecosystem/21` §3), so paying it out in Shards meant a grant that could not be reconstructed
against its own funding. The danger was not that this would fail loudly — it was that it would
*succeed*: the ledger's retired-asset guard covers acquisition kinds only (`purchase`,
`subscription_charge`, `deposit_credited`), and `reward_granted` is not one of them. A SHARD reward
would have posted a `201`, raised a user liability with no custody behind it, and frozen SHARD
withdrawals on a drift that only issuing more SHARD could clear — which `assertIssuable` refuses by
name. Nothing had run through it yet (0 engagement accounts, 0 `reward_granted` entries on mainnet,
2026-08-10), which is the only reason this was a change rather than an incident.

The asset is spelled once, as `ENGAGEMENT_ASSET` in `src/ledgerclient.ts`, and typed
`IssuableAssetCode` — `Exclude<AssetCode, 'SHARD'>` from `contracts-chain`. Routing a reward back
through a retired asset does not compile.

### The rate, and why it is frozen

Migration 9 renamed `reward_budget_shards` → `reward_budget_wei`, `rewards_granted_shards` →
`rewards_granted_wei` and `amount_shards` → `amount_wei`, converting each by **40000000000000000**.
That is a real conversion and not a relabelling — SHARD has 0 decimals and EMBER has 18 — built from
two recorded facts: one Shard is one US cent (`SHARDS_PER_USD = 100n`), and one EMBER is 0.25 USD
(`pricing.administered_prices`, `usd_scaled` 250000). So 1 Shard = 0.04 EMBER = 4e16 wei.

The literal is frozen into the migration, and `micro-admin-api`'s migration 13 and `micro-worlds`'
migration 11 freeze the identical constant. A migration runs **once** and is checksummed
afterwards; an administered price is one operator-editable row. A stored figure that re-read the
price would restate itself every time somebody edited that number.

`EMBERKIN_SEASON_REWARD_BUDGET_SHARDS` is **refused at boot**, not accepted-and-ignored — see
`.env.example`. Accepting it would silently fall back to the default: a budget nobody chose,
presented as one somebody did.

## Right to erasure

Rule 6 of `docs/ecosystem/03` §2: a service storing a `user_id` subscribes to
`identity.user.deleted`. On that event the save is deleted (battles follow by foreign-key cascade),
achievements are deleted, and queued jobs and emitted outbox rows naming the user go with them.

**One row survives, anonymised: `reward_grants`.** It is the local record of a ledger posting that
moved real money, and `seasons.rewards_granted_wei` is the total it has to keep reconciling
against — deleting it would leave the season reporting spend with nothing to account for. Its
`user_id` becomes a random uuid, its `idempotency_key` is overwritten (the derived key embedded the
raw uuid in plain text) and `user_erased_at` marks it, with a database trigger making the erasure
one-way: an anonymised grant can never be re-attributed to a person. The per-table reasoning and
the lawful basis for each decision are in the header of `src/erasure.ts`, in the code, so they
cannot drift from the behaviour.

**The event reaches BOTH titles.** Aetherholm subscribes to the same topic and erases its own nine
`user_id` columns in its own database, on the same delivery — the single `POST /v1/events` fans out
rather than choosing. This is the one place a merged webhook could have been quietly wrong: routing
the deletion to one module answers 202, the producer marks it delivered, and every city that person
founded is still standing with nothing anywhere saying so. `src/merged.test.ts` plants a row in each
database and asserts **the rows**, not the 202.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
