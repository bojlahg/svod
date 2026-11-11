import { query } from "@/db";
import {
  SVOD_PASSAGE_BATCH,
  embedSvodPassages,
  getSvodEmbedState,
} from "@/lib/embed";
import { toVector } from "@/db";

/**
 * SVOD stage 5 worker: durable section embeddings.
 *
 * Source of truth is `svod_embed_outbox` (one open row per chunk, written in
 * the same tx as the chunk). pg-boss (`svod-index` queue) only wakes the
 * worker; a lost `send` is recovered by the start-up + periodic sweep, which
 * is why the sweep must run even without a live pg-boss.
 *
 * - Claim uses FOR UPDATE SKIP LOCKED and reclaims locks older than 2
 *   minutes; passage batches are at most 8 texts. Between batches the queue
 *   is re-read, so an edited note never waits behind a corpus tail.
 * - Duplicate inputs inside one batch are embedded once and the vector is
 *   copied to every chunk with that hash.
 * - One SQL statement writes the vector and drops the queue row: a late
 *   result (hash changed mid-job) deletes nothing, so the new revision's
 *   work survives; a rejected write keeps its outbox row and is recorded
 *   through the failure path instead of being dropped.
 * - Service failures keep the note and its lexical chunk, fill `embed_error`,
 *   back off, and after 5 attempts set `error` (outbox kept for the manual
 *   refresh). Search never throws when the service is dead.
 * - Never touches `file_links` or the note's updated_at; only chunks + outbox.
 */

export const SVOD_INDEX_MAX_ATTEMPTS = 5;

export interface SvodClaim {
  outboxId: string;
  chunkId: string;
  brainId: string;
  noteId: string;
  inputHash: string;
  attempts: number;
  content: string;
}

function backoffDelay(attempts: number): string {
  // 10s, 20s, 40s, 80s, 160s — capped well below the sweep interval's pain.
  const secs = Math.min(300, 10 * 2 ** Math.min(attempts, 5));
  return `${secs} seconds`;
}

/** Claim up to `limit` due rows and lock them. Automatic retries only see
 *  `pending` chunks; `error` waits for the manual refresh (which flips it
 *  back to pending).
 *
 *  A lock older than 2 minutes counts as free: a worker that died between
 *  the claim and the unlock must not strand its rows — the outbox survives
 *  a dead worker, so the next sweep reclaims them. */
export async function claimSvodOutbox(limit = SVOD_PASSAGE_BATCH): Promise<SvodClaim[]> {
  try {
    const rows = await query<SvodClaim & { id: string; chunk_id: string; brain_id: string; note_id: string; input_hash: string }>(
      `with due as (
         select o.id, o.chunk_id, o.brain_id, o.note_id, o.input_hash, o.attempts,
                c.content as content
           from svod_embed_outbox o
           join chunks c on c.id = o.chunk_id
           join notes n on n.id = o.note_id and n.id = c.note_id
          where o.not_before <= now()
            and (o.locked_at is null or o.locked_at < now() - interval '2 minutes')
            and c.embed_state = 'pending'
            and c.input_hash = o.input_hash
            and n.status = 'active'
            and n.brain_id = o.brain_id
          order by o.created_at
          limit $1
          for update of o skip locked
       )
       update svod_embed_outbox o set locked_at = now()
         from due where o.id = due.id
       returning due.id as "outboxId", due.chunk_id as "chunkId",
                 due.brain_id as "brainId", due.note_id as "noteId",
                 due.input_hash as "inputHash", due.attempts as attempts,
                 due.content as content`,
      [Math.min(limit, SVOD_PASSAGE_BATCH)],
    );
    return rows as SvodClaim[];
  } catch {
    // Pre-0096 database (unit tests with a stubbed pool): nothing due.
    return [];
  }
}

async function markSvodError(claim: SvodClaim, message: string): Promise<void> {
  const attempts = claim.attempts + 1;
  const short = message.slice(0, 500);
  if (attempts >= SVOD_INDEX_MAX_ATTEMPTS) {
    await query(
      `update chunks set embed_error = $2, embed_state = 'error'
        where id = $1 and input_hash = $3`,
      [claim.chunkId, short, claim.inputHash],
    ).catch(() => {});
    // Outbox row stays for the manual refresh; park it so the automatic
    // sweep does not spin on it (claim only sees pending).
    await query(
      `update svod_embed_outbox set attempts = $2, last_error = $3,
              locked_at = null, not_before = now() + interval '24 hours'
        where id = $1`,
      [claim.outboxId, attempts, short],
    ).catch(() => {});
    return;
  }
  await query(
    `update chunks set embed_error = $2 where id = $1 and input_hash = $3`,
    [claim.chunkId, short, claim.inputHash],
  ).catch(() => {});
  await query(
    `update svod_embed_outbox set attempts = $2, last_error = $3,
            locked_at = null, not_before = now() + (${backoffDelay(attempts)})::interval
      where id = $1`,
    [claim.outboxId, attempts, short],
  ).catch(() => {});
}

export type SvodApplyOutcome = "applied" | "already" | "dropped-inactive" | "stale";

/**
 * Apply one embedded vector with a single SQL statement — no swallowed
 * errors, no separate delete that can drop a queue row for a failed write.
 *
 * - The vector lands only when chunk id, input hash, base and an active note
 *   all still match and the fingerprint is still different.
 * - The outbox row goes away only when that update wrote a row, or the chunk
 *   already holds this exact fingerprint as `ready` (a repeated input whose
 *   twin landed first), or the note is no longer `active` (then no vector is
 *   written). A changed hash deletes nothing: the new revision's work stays.
 * - If the statement itself throws (rejected halfvec, lost connection), the
 *   outbox row stays and the error propagates to the sweep, which records it
 *   through the normal failure path (embed_error, backoff, error after 5).
 */
export async function applySvodVector(
  claim: SvodClaim,
  vector: number[],
  fingerprintId: string,
): Promise<{ outcome: SvodApplyOutcome }> {
  const vec = toVector(vector);
  const rows = await query<{ outcome: SvodApplyOutcome }>(
    `with upd as (
       update chunks
          set embedding = $1,
              embed_fingerprint = $2,
              embed_state = 'ready',
              embed_error = null
        where id = $3
          and input_hash = $4
          and brain_id = $5
          and embed_fingerprint is distinct from $2
          and exists (
            select 1 from notes n
             where n.id = chunks.note_id
               and n.brain_id = $5
               and n.status = 'active'
          )
        returning 1
     ),
     del as (
       delete from svod_embed_outbox o
        where o.id = $6
          and o.input_hash = $4
          and exists (
            select 1 from chunks c
             where c.id = $3 and c.input_hash = $4
          )
          and (
            (select count(*) from upd) > 0
            or exists (
              select 1 from chunks c
               where c.id = $3
                 and c.embed_state = 'ready'
                 and c.embed_fingerprint = $2
            )
            or not exists (
              select 1 from notes n
               join chunks c on c.note_id = n.id
               where c.id = $3 and n.status = 'active' and n.brain_id = $5
            )
          )
        returning 1
     )
     select case
              when (select count(*) from upd) > 0 then 'applied'
              when exists (
                select 1 from chunks c
                 where c.id = $3
                   and c.embed_state = 'ready'
                   and c.embed_fingerprint = $2
              ) then 'already'
              when (select count(*) from del) > 0 then 'dropped-inactive'
              else 'stale'
            end as outcome`,
    [vec, fingerprintId, claim.chunkId, claim.inputHash, claim.brainId, claim.outboxId],
  );
  return { outcome: rows[0]?.outcome ?? "stale" };
}

/**
 * One sweep: re-read the queue between batches. Returns what happened for
 * logging/tests. Never throws for a dead embed service (lexical search keeps
 * working); per-chunk failures are recorded on the chunk, not raised.
 */
export async function sweepSvodIndex(opts?: {
  embedFn?: (texts: string[]) => Promise<{ vectors: number[][]; fingerprintId: string }>;
  claimFn?: (limit: number) => Promise<SvodClaim[]>;
}): Promise<{ batches: number; embedded: number; errors: number; skipped: string | null }> {
  const claimFn = opts?.claimFn ?? claimSvodOutbox;
  let batches = 0;
  let embedded = 0;
  let errors = 0;

  for (;;) {
    // Fingerprint gate: semantic writes need both endpoints confirmed with
    // the same id. Otherwise leave every row for the next sweep (no attempt
    // counted, no error recorded).
    if (!opts?.embedFn) {
      const state = await getSvodEmbedState().catch(() => null);
      if (!state || !state.usable) {
        return { batches, embedded, errors, skipped: state?.reason ?? "embed unavailable" };
      }
    }
    const claims = await claimFn(SVOD_PASSAGE_BATCH);
    if (!claims.length) return { batches, embedded, errors, skipped: batches ? null : "empty" };

    // Deduplicate texts: one inference per unique input, vector copied.
    const byHash = new Map<string, SvodClaim[]>();
    for (const c of claims) {
      const list = byHash.get(c.inputHash) ?? [];
      list.push(c);
      byHash.set(c.inputHash, list);
    }
    const hashes = [...byHash.keys()];
    const representatives = hashes.map((h) => byHash.get(h)![0]);
    const texts = representatives.map((c) => c.content);

    let vectors: number[][];
    let fingerprintId: string;
    try {
      if (opts?.embedFn) {
        const r = await opts.embedFn(texts);
        vectors = r.vectors;
        fingerprintId = r.fingerprintId;
      } else {
        const r = await embedSvodPassages(texts);
        vectors = r.vectors;
        fingerprintId = r.fingerprintId;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const c of claims) await markSvodError(c, msg);
      errors += claims.length;
      batches += 1;
      continue;
    }

    if (vectors.length !== texts.length) {
      for (const c of claims) await markSvodError(c, "embed count mismatch");
      errors += claims.length;
      batches += 1;
      continue;
    }

    for (let i = 0; i < representatives.length; i++) {
      const vec = vectors[i];
      if (!Array.isArray(vec) || vec.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
        for (const c of byHash.get(hashes[i])!) await markSvodError(c, "embed returned non-finite values");
        errors += byHash.get(hashes[i])!.length;
        continue;
      }
      for (const c of byHash.get(hashes[i])!) {
        // A rejected write (bad vector, lost row race) keeps its outbox row
        // and is recorded through the normal failure path — never dropped.
        try {
          const r = await applySvodVector(c, vec, fingerprintId);
          if (r.outcome === "applied" || r.outcome === "already") embedded += 1;
        } catch (e) {
          await markSvodError(c, e instanceof Error ? e.message : String(e));
          errors += 1;
        }
      }
    }
    batches += 1;
  }
}

/** pg-boss wake-up handler body (also called by the periodic sweep). */
export async function runSvodIndex(): Promise<void> {
  await sweepSvodIndex();
}
