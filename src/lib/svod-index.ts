import type { PoolClient } from "pg";
import { query, tx } from "@/db";
import { estimateTokens } from "@/lib/chunk";
import { svodSectionsForNote } from "@/lib/svod-sections";

/**
 * SVOD stage 5 section sync.
 *
 * One note stays one `notes` row; each section is one `chunks` row whose
 * content is the embed input (`title + "\n\n" + slice`) and whose identity
 * is SHA-256 of that input (`input_hash`), not the position.
 *
 * - Unchanged inputs keep their chunk id (and a compatible vector when the
 *   fingerprint is still current — decided by the caller/worker, never
 *   erased here).
 * - Reordered sections and neighbour edits never change this hash.
 * - Duplicate inputs inside one note are separate rows; a repeat whose twin
 *   in the same note is already embedded copies the finished vector (no new
 *   inference, no outbox row), otherwise the worker embeds the text once and
 *   copies the vector.
 * - Legacy chunks (NULL hash) never match: the first real sync replaces them.
 * - New/changed sections become `pending` with NULL vector. With auto-index
 *   on, an outbox row is written in the SAME transaction; with auto-index
 *   off, no outbox row (manual refresh queues later).
 */

interface ExistingChunk {
  id: string;
  input_hash: string | null;
  section_ordinal: number | null;
  embed_state: string;
  embed_fingerprint: string | null;
  embedding: string | null;
}

/** Only a missing 0096 column (Postgres 42703) falls back to pre-0096
 *  behaviour. Any other database error is real and must abort the write
 *  instead of silently duplicating or dropping chunks. */
function isMissingColumn(err: unknown): boolean {
  return (err as { code?: string })?.code === "42703";
}

async function brainAutoIndex(
  client: PoolClient,
  brainId: string,
): Promise<boolean> {
  try {
    const r = await client.query<{ auto_index: boolean }>(
      `select auto_index from brains where id = $1`,
      [brainId],
    );
    return r.rows[0]?.auto_index === true;
  } catch (err) {
    // Pre-0096 database: no auto_index column yet, treat as manual.
    if (isMissingColumn(err)) return false;
    throw err;
  }
}

async function queueOutboxForChunk(
  client: PoolClient,
  brainId: string,
  noteId: string,
  chunkId: string,
  inputHash: string,
): Promise<boolean> {
  try {
    // Same hash: keep the existing row (attempts/lock/not_before survive, so
    // a concurrent worker claim is never clobbered). Changed hash mid-job:
    // reset to the new work so the old vector can never close it.
    await client.query(
      `insert into svod_embed_outbox (chunk_id, brain_id, note_id, input_hash)
       values ($1, $2, $3, $4)
       on conflict (chunk_id) do update
         set input_hash = excluded.input_hash,
             brain_id = excluded.brain_id,
             note_id = excluded.note_id,
             locked_at = null,
             not_before = now(),
             attempts = 0,
             last_error = null
         where svod_embed_outbox.input_hash is distinct from excluded.input_hash`,
      [chunkId, brainId, noteId, inputHash],
    );
    return true;
  } catch (err) {
    // Pre-0096 database: no outbox table yet and (via brainAutoIndex) no
    // auto-index either, so there is nothing to queue.
    if (isMissingColumn(err)) return false;
    throw err;
  }
}

/**
 * Reconcile the chunk rows of one active note with its current sections.
 * Must run inside the caller's write transaction (same tx as the note row).
 * Never touches `notes.updated_at`/file links; only chunks + outbox.
 *
 * Returns whether any outbox row was (or should be) queued, so the caller
 * can wake the worker after commit (best-effort: the outbox row already
 * survives a lost wake-up and the periodic sweep picks it up).
 */
export async function syncSvodSections(
  client: PoolClient,
  opts: { brainId: string; noteId: string; title: string; body: string },
): Promise<{ queued: boolean; autoIndex: boolean }> {
  const { brainId, noteId, title, body } = opts;
  const autoIndex = await brainAutoIndex(client, brainId);
  const sections = svodSectionsForNote(title, body);

  let existing: ExistingChunk[] = [];
  try {
    const r = await client.query<ExistingChunk>(
      `select id, input_hash, section_ordinal, embed_state, embed_fingerprint, embedding::text as embedding
         from chunks
        where note_id = $1 order by section_ordinal nulls last, id`,
      [noteId],
    );
    existing = r.rows;
  } catch (err) {
    // Pre-0096 chunks table: no section columns yet, so nothing can match —
    // the first real sync replaces every legacy row below.
    if (!isMissingColumn(err)) throw err;
    existing = [];
  }

  // Match new sections to old chunks by hash, preferring the same position.
  const unmatched = new Map<string, ExistingChunk>();
  for (const c of existing) unmatched.set(c.id, c);
  const byHash = new Map<string, ExistingChunk[]>();
  for (const c of existing) {
    if (!c.input_hash) continue;
    const list = byHash.get(c.input_hash) ?? [];
    list.push(c);
    byHash.set(c.input_hash, list);
  }
  const kept = new Map<string, string>(); // new index -> old chunk id
  const usedOld = new Set<string>();

  for (let i = 0; i < sections.length; i++) {
    const h = sections[i].hash;
    const candidates = (byHash.get(h) ?? []).filter((c) => !usedOld.has(c.id));
    if (!candidates.length) continue;
    const samePos = candidates.find((c) => c.section_ordinal === i);
    const pick = samePos ?? candidates[0];
    kept.set(String(i), pick.id);
    usedOld.add(pick.id);
    unmatched.delete(pick.id);
  }

  // Delete unmatched old chunks (legacy + removed sections). Their outbox
  // rows die by cascade.
  for (const id of unmatched.keys()) {
    await client.query(`delete from chunks where id = $1`, [id]);
  }

  let queued = false;
  // Ready vectors already present in THIS note, by input hash: a repeated
  // section copies the finished vector instead of queueing new work. Only
  // the same note is ever a copy source — never another note or base.
  const readyByHash = new Map<string, { embedding: string; fingerprint: string }>();
  for (const [, oldId] of kept) {
    const old = existing.find((c) => c.id === oldId);
    if (
      old?.input_hash &&
      old.embed_state === "ready" &&
      old.embed_fingerprint &&
      old.embedding
    ) {
      readyByHash.set(old.input_hash, {
        embedding: old.embedding,
        fingerprint: old.embed_fingerprint,
      });
    }
  }
  // Update kept rows to their new ordinal/content (content is identical when
  // the hash matches, but the ordinal may have moved).
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const oldId = kept.get(String(i));
    if (oldId) {
      await client.query(
        `update chunks set section_ordinal = $2, content = $3, token_count = $4
          where id = $1`,
        [oldId, sec.ordinal, sec.input, estimateTokens(sec.input)],
      );
      // With auto-index on, make sure a still-pending kept row is queued
      // (it may predate auto-index and have no outbox row yet).
      const old = existing.find((c) => c.id === oldId);
      if (autoIndex && old && (old.embed_state === "pending" || old.embed_state === "error")) {
        if (await queueOutboxForChunk(client, brainId, noteId, oldId, sec.hash)) queued = true;
      }
      continue;
    }
    // A repeated section whose twin in this note is already embedded copies
    // the finished vector and fingerprint and stays `ready`: no inference,
    // no outbox row for the copy.
    const twin = readyByHash.get(sec.hash);
    if (twin) {
      try {
        await client.query(
          `insert into chunks
             (brain_id, note_id, content, token_count, input_hash, section_ordinal,
              embed_state, embedding, embed_fingerprint, embed_error)
           values ($1, $2, $3, $4, $5, $6, 'ready', $7::halfvec, $8, null)`,
          [brainId, noteId, sec.input, estimateTokens(sec.input), sec.hash, sec.ordinal, twin.embedding, twin.fingerprint],
        );
      } catch (err) {
        if (!isMissingColumn(err)) throw err;
        // Pre-0096 schema: fall back to the legacy insert (see below).
        await client.query(
          `insert into chunks (brain_id, note_id, content, token_count, embedding)
           values ($1, $2, $3, $4, null)`,
          [brainId, noteId, sec.input, estimateTokens(sec.input)],
        );
      }
      continue;
    }
    // New section: lexical row now, vector later.
    let newId: string | null = null;
    try {
      const r = await client.query<{ id: string }>(
        `insert into chunks
           (brain_id, note_id, content, token_count, input_hash, section_ordinal,
            embed_state, embedding, embed_fingerprint, embed_error)
         values ($1, $2, $3, $4, $5, $6, 'pending', null, null, null)
         returning id`,
        [brainId, noteId, sec.input, estimateTokens(sec.input), sec.hash, sec.ordinal],
      );
      newId = r.rows[0]?.id ?? null;
    } catch (err) {
      // Pre-0096 schema (no new columns): fall back to the legacy insert so
      // old tests/databases keep working; the first real 0096 sync replaces it.
      if (!isMissingColumn(err)) throw err;
      const r = await client.query<{ id: string }>(
        `insert into chunks (brain_id, note_id, content, token_count, embedding)
         values ($1, $2, $3, $4, null) returning id`,
        [brainId, noteId, sec.input, estimateTokens(sec.input)],
      );
      newId = r.rows[0]?.id ?? null;
    }
    if (newId && autoIndex) {
      if (await queueOutboxForChunk(client, brainId, noteId, newId, sec.hash)) queued = true;
    }
  }

  return { queued, autoIndex };
}

/** Best-effort worker wake-up. The outbox row is already committed; a lost
 *  `send` is recovered by the start-up + periodic sweep. Never throws. */
export async function wakeSvodIndexer(): Promise<void> {
  try {
    const { getBoss, QUEUES } = await import("@/worker/queue");
    const boss = await getBoss();
    const name = (QUEUES as Record<string, string>).svodIndex ?? "svod-index";
    await boss.send(name, {}, { singletonKey: `svod-index-wake`, singletonSeconds: 5 });
  } catch {
    // Lost wake-up: the sweep picks the outbox rows up anyway.
  }
}

export interface SvodIndexStatus {
  autoIndex: boolean;
  pendingNotes: number;
  pendingChunks: number;
  errorChunks: number;
  lastError: string | null;
}

/** Read-only status for the workspace page. Requires only read access. */
export async function getSvodIndexStatus(brainId: string): Promise<SvodIndexStatus> {
  const autoRow = await query<{ auto_index: boolean }>(
    `select auto_index from brains where id = $1`,
    [brainId],
  ).catch(() => [] as { auto_index: boolean }[]);
  const autoIndex = autoRow[0]?.auto_index === true;
  const counts = await query<{ pending_notes: number; pending_chunks: number; error_chunks: number }>(
    `select
       count(distinct case when c.embed_state in ('pending', 'error') then c.note_id end)::int as pending_notes,
       count(*) filter (where c.embed_state = 'pending')::int as pending_chunks,
       count(*) filter (where c.embed_state = 'error')::int as error_chunks
       from chunks c join notes n on n.id = c.note_id
      where c.brain_id = $1 and n.brain_id = $1 and n.status = 'active'`,
    [brainId],
  ).catch(() => [{ pending_notes: 0, pending_chunks: 0, error_chunks: 0 }]);
  const c = counts[0] ?? { pending_notes: 0, pending_chunks: 0, error_chunks: 0 };
  // Last error: prefer the chunk field, fall back to the outbox row.
  let lastError: string | null = null;
  try {
    const rows = await query<{ embed_error: string | null }>(
      `select c.embed_error from chunks c join notes n on n.id = c.note_id
        where c.brain_id = $1 and n.status = 'active' and c.embed_error is not null
        order by c.id desc limit 1`,
      [brainId],
    );
    lastError = rows[0]?.embed_error ?? null;
    if (!lastError) {
      const ob = await query<{ last_error: string | null }>(
        `select last_error from svod_embed_outbox where brain_id = $1 and last_error is not null
          order by created_at desc limit 1`,
        [brainId],
      );
      lastError = ob[0]?.last_error ?? null;
    }
  } catch {
    lastError = null;
  }
  return {
    autoIndex,
    pendingNotes: c.pending_notes,
    pendingChunks: c.pending_chunks,
    errorChunks: c.error_chunks,
    lastError,
  };
}

/**
 * Manual "Refresh embeddings": re-sync sections of every active note in the
 * base, then queue outbox rows for chunks without the current confirmed
 * fingerprint and for `error` (which is flipped back to pending with a fresh
 * budget). Works regardless of `auto_index`. Never throws for a dead embed
 * service: pending/error rows are still queued for the next sweep.
 */
export async function refreshSvodBrain(brainId: string): Promise<{ notes: number; queued: number }> {
  const notes = await query<{ id: string; title: string; body: string }>(
    `select id, title, body from notes where brain_id = $1 and status = 'active'`,
    [brainId],
  ).catch(() => [] as { id: string; title: string; body: string }[]);

  for (const n of notes) {
    await tx(async (client) => {
      await syncSvodSections(client, { brainId, noteId: n.id, title: n.title, body: n.body });
    }).catch(() => {});
  }

  let fpId: string | null = null;
  try {
    const { getSvodEmbedState } = await import("@/lib/embed");
    const st = await getSvodEmbedState();
    if (st.usable) fpId = st.fingerprintId;
  } catch {
    fpId = null;
  }

  const queued = await queueBrainOutbox(brainId, fpId).catch(() => 0);
  if (queued > 0) await wakeSvodIndexer().catch(() => {});
  return { notes: notes.length, queued };
}

/**
 * Queue outbox rows for a whole base:
 * - always: pending/error chunks (error is retried with a fresh budget);
 * - when a confirmed fingerprint id is known: ready chunks whose fingerprint
 *   is not current (they flip to pending).
 * Returns the number of outbox rows ensured.
 */
export async function queueBrainOutbox(brainId: string, fingerprintId: string | null): Promise<number> {
  // Flip stale/error rows to pending (keeping embed_error for the status
  // line until the worker clears it on success).
  if (fingerprintId) {
    await query(
      `update chunks set embed_state = 'pending'
        where brain_id = $1
          and embed_state in ('ready', 'error')
          and embed_fingerprint is distinct from $2
          and exists (
            select 1 from notes n
             where n.id = chunks.note_id and n.brain_id = $1 and n.status = 'active'
          )`,
      [brainId, fingerprintId],
    ).catch(() => {});
    // Manual retry of parked error rows.
    await query(
      `update chunks set embed_state = 'pending'
        where brain_id = $1 and embed_state = 'error'
          and exists (
            select 1 from notes n
             where n.id = chunks.note_id and n.brain_id = $1 and n.status = 'active'
          )`,
      [brainId],
    ).catch(() => {});
  } else {
    await query(
      `update chunks set embed_state = 'pending'
        where brain_id = $1 and embed_state = 'error'
          and exists (
            select 1 from notes n
             where n.id = chunks.note_id and n.brain_id = $1 and n.status = 'active'
          )`,
      [brainId],
    ).catch(() => {});
  }

  // Ensure one outbox row per needing chunk; reset parked rows so the sweep
  // picks them up now (attempts restart — the button is a deliberate retry).
  const rows = await query<{ id: string }>(
    `insert into svod_embed_outbox (chunk_id, brain_id, note_id, input_hash)
     select c.id, c.brain_id, c.note_id, c.input_hash
       from chunks c
       join notes n on n.id = c.note_id
      where c.brain_id = $1 and n.brain_id = $1 and n.status = 'active'
        and c.input_hash is not null
        and c.embed_state = 'pending'
     on conflict (chunk_id) do update
       set input_hash = excluded.input_hash,
           locked_at = null,
           not_before = now(),
           attempts = 0
     returning id`,
    [brainId],
  ).catch(() => [] as { id: string }[]);
  return rows.length;
}

/**
 * Auto-index switch. Enabling queues the existing backlog (same rule as the
 * manual refresh); disabling never cancels already-queued rows.
 */
export async function setSvodAutoIndex(brainId: string, enabled: boolean): Promise<{ queued: number }> {
  await query(`update brains set auto_index = $2 where id = $1`, [brainId, enabled]).catch(() => {});
  if (!enabled) return { queued: 0 };
  let fpId: string | null = null;
  try {
    const { getSvodEmbedState } = await import("@/lib/embed");
    const st = await getSvodEmbedState();
    if (st.usable) fpId = st.fingerprintId;
  } catch {
    fpId = null;
  }
  const queued = await queueBrainOutbox(brainId, fpId).catch(() => 0);
  if (queued > 0) await wakeSvodIndexer().catch(() => {});
  return { queued };
}
