/**
 * The ledger, as this service uses it.
 *
 * **This service holds no balance, and a reward is not a column.** A season reward is a ledger
 * posting, because a game exploit that mints rewards is then a MONEY INCIDENT reconciled against
 * the ledger rather than a number that appeared in a save row. The idempotency key is derived from
 * `(season, user, reason)`, so a retried grant posts once: the ledger replays its stored answer and
 * the local `reward_grants.idempotency_key UNIQUE` refuses the second row.
 */

import { HttpClient, HttpError } from '@cloudsforge/http';
import type { Actor, EntryKind, LedgerAssetCode } from '@cloudsforge/contracts-money';

export const LEDGER_SCOPES: readonly string[] = Object.freeze(['ledger:post']);

/** The ledger refused on the state of the world (e.g. insufficient balance). Never retried as-is. */
export class LedgerRefusedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LedgerRefusedError';
    this.code = code;
    this.status = status;
  }
}

/** The ledger could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerUnavailableError';
  }
}

export interface AccountRef {
  readonly subject: string;
  readonly assetCode: LedgerAssetCode;
  readonly purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense';
  readonly type: 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing';
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit';
  readonly amount: bigint;
  readonly assetCode: LedgerAssetCode;
  readonly sequence: number;
  readonly account: AccountRef;
}

export interface PostEntryRequest {
  readonly kind: EntryKind;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly description?: string;
  readonly postings: readonly PostingRequest[];
}

export interface PostedEntry {
  readonly id: string;
  readonly kind: string;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>;
}

/**
 * The two postings that pay a reward: the platform's promotional expense out, the player's balance
 * in. Balanced by construction — the same number on both sides.
 */
export function rewardPostings(input: { readonly subject: string; readonly amount: bigint }): readonly PostingRequest[] {
  return [
    {
      account: { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'expense' },
      direction: 'debit',
      amount: input.amount,
      assetCode: 'SHARD',
      sequence: 0,
    },
    {
      account: { subject: input.subject, assetCode: 'SHARD', purpose: 'available', type: 'liability' },
      direction: 'credit',
      amount: input.amount,
      assetCode: 'SHARD',
      sequence: 1,
    },
  ];
}

/** The key one reward is posted under, for ever — DERIVED from `(season, user, reason)`. */
export function rewardIdempotencyKey(seasonId: string, userId: string, reason: string): string {
  return `emberkin:reward:${seasonId}:${userId}:${reason}`;
}

export interface LedgerClientOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string | undefined> | string | undefined;
  readonly deadlineMs: number;
  readonly originatingService: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface RawEntry {
  readonly id: string;
  readonly kind: string;
  readonly recordedAt: string;
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async postEntry(request) {
      try {
        const body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          body: {
            kind: request.kind,
            originatingService: options.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              // Smallest units as a decimal STRING in both directions — a JSON number is an IEEE
              // 754 double and a large amount comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        });
        return { id: body.entry.id, kind: body.entry.kind, recordedAt: body.entry.recordedAt, replayed: body.replayed };
      } catch (err) {
        throw translate(err);
      }
    },
  };
}

function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body);
    return new LedgerRefusedError(err.status, parsed.code, parsed.message);
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err;
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err));
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    };
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) };
  }
}
