import { maybeOne, query, tx } from "@/db";
import type { PoolClient } from "pg";
import type { Note } from "@/db/types";
import { chunksForNote, estimateTokens } from "@/lib/chunk";
import { normalizeCategory } from "@/lib/category";
import { toTsQuery } from "@/lib/tsquery";
import { folderInBrain, isUuid } from "@/lib/svod-folders";
import { syncSvodSections, wakeSvodIndexer } from "@/lib/svod-index";

/**
 * SVOD stage 3 note writes: Markdown-only, no paid LLM, no embeddings required.
 *
 * Stage 5: ACTIVE notes are indexed by SECTIONS (src/lib/svod-sections.ts),
 * not by chunkText. `chunkText`/`chunksForNote` stay untouched for the old
 * ingest and exams; Svod writes go through syncSvodSections, which keeps
 * unchanged section hashes (and their vectors) stable across neighbour edits,
 * reorderings and duplicate inputs.
 *
 * - Original bytes preserved: validate/store return the exact input string
 *   (BOM/CRLF/whitespace/fences untouched). Blank means whitespace-only, but
 *   the stored body is never trimmed. NUL is rejected (it truncates in PG).
 * - New/edited ACTIVE notes get searchable lexical section rows transactionally
 *   (same tx as the note + outbox). New/changed sections are `pending`;
 *   with auto-index on an outbox row is written in the same tx, otherwise the
 *   manual refresh queues later. Embeddings stay NULL until the worker fills
 *   them — lexical search (tsv) works immediately.
 * - Unchanged saves are no-ops: same title + same body (modulo textarea CRLF
 *   normalisation) keeps the row, the vectors and the chunk IDs untouched.
 * - Moves keep IDs and vectors: only folder_id changes, chunks untouched.
 * - Pending proposals never get chunks here and never appear in search/tree;
 *   proposal editing lands in stage 4. All normal mutations and reads below
 *   are active-only at the SQL boundary.
 * - Body/status and search stay in sync: section rewrites happen in the same
 *   transaction as the note change.
 */

export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BODY = 100_000;
export const MAX_MD_UPLOAD_BYTES = 200 * 1024;

const normForCompare = (s: string): string => s.replace(/\r\n?/g, "\n");

export function validateNoteTitle(raw: unknown): { ok: true; title: string } | { ok: false; error: string } {
  const title = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!title) return { ok: false, error: "Give the note a title." };
  if (title.length > MAX_NOTE_TITLE) return { ok: false, error: "Title is too long (max 200)." };
  return { ok: true, title };
}

export function validateNoteBody(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  // Byte-preserving: the exact input string is stored and downloaded.
  // Blank is whitespace-only (checked without trimming the stored body).
  const body = String(raw ?? "");
  if (body.includes("\0")) return { ok: false, error: "Note cannot contain NUL bytes." };
  if (!body.replace(/\s/g, "")) return { ok: false, error: "The note is empty." };
  if (body.length > MAX_NOTE_BODY) {
    return { ok: false, error: `Note is too long (${body.length} chars, max ${MAX_NOTE_BODY}). Split it.` };
  }
  return { ok: true, body };
}

async function insertLexicalChunks(
  client: PoolClient,
  brainId: string,
  noteId: string,
  title: string,
  body: string,
): Promise<void> {
  // Legacy stage-3 helper, kept for the pre-0096 fallback path and for the
  // atomic-write regression test (embedding) values (…null) shape.
  const texts = chunksForNote(title, body);
  if (!texts.length) return;
  for (const text of texts) {
    await client.query(
      `insert into chunks (brain_id, note_id, content, token_count, embedding)
       values ($1, $2, $3, $4, null)`,
      [brainId, noteId, text, estimateTokens(text)],
    );
  }
}

/**
 * Decode an uploaded .md file: fatal UTF-8 with BOM preserved.
 *
 * TextDecoder strips a leading BOM by default; `ignoreBOM: true` keeps the
 * marker in the decoded string so the exact input bytes round-trip through
 * store → download (Buffer.from(text, "utf8") reproduces EF BB BF).
 */
export function decodeMdBytes(buf: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    return { ok: true, text };
  } catch {
    return { ok: false, error: "Could not read the file as UTF-8." };
  }
}

export async function createSvodNote(opts: {
  brainId: string;
  folderId: string | null;
  title: string;
  body: string;
  /** Stage 4 token attribution (project direct-write / reviewer creates). */
  tokenId?: string | null;
  author?: "human" | "agent";
  agentClient?: string | null;
}): Promise<Note> {
  if (!isUuid(opts.brainId)) throw new Error("Base not found.");
  if (opts.folderId && !isUuid(opts.folderId)) throw new Error("Folder is in another base.");
  if (opts.tokenId && !isUuid(opts.tokenId)) throw new Error("Base not found.");
  if (opts.folderId) {
    const f = await folderInBrain(opts.folderId, opts.brainId);
    if (!f) throw new Error("Folder is in another base.");
  }
  const out = await tx(async (client) => {
    // Lock the base row so a concurrent base delete serializes here.
    await client.query(`select id from brains where id = $1 for update`, [opts.brainId]);
    if (opts.folderId) {
      const lock = await client.query(`select id from folders where id = $1 and brain_id = $2 for update`, [
        opts.folderId,
        opts.brainId,
      ]);
      if (!lock.rowCount) throw new Error("Folder is in another base.");
    }
    const rows = await client.query<Note>(
      `insert into notes (brain_id, folder_id, title, body, author, agent_client, status, token_id, updated_token_id)
       values ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
       returning *`,
      [
        opts.brainId,
        opts.folderId,
        opts.title,
        opts.body,
        opts.author ?? "human",
        opts.agentClient ?? null,
        opts.tokenId ?? null,
      ],
    );
    const note = rows.rows[0];
    // Stage 5 sections: lexical rows + pending state + outbox in the same tx.
    // Pre-0096 fallback stays inside syncSvodSections; insertLexicalChunks
    // remains the legacy shape reference (see atomic-write test).
    let queued = false;
    try {
      const sync = await syncSvodSections(client, {
        brainId: opts.brainId,
        noteId: note.id,
        title: opts.title,
        body: opts.body,
      });
      queued = sync.queued;
    } catch {
      await insertLexicalChunks(client, opts.brainId, note.id, opts.title, opts.body);
    }
    await client.query(`update brains set content_changed_at = now() where id = $1`, [opts.brainId]);
    return { note, queued };
  });
  // Wake after commit: the outbox row is already durable, so a lost send is
  // recovered by the periodic sweep.
  if (out.queued) await wakeSvodIndexer().catch(() => {});
  return out.note;
}

export async function updateSvodNote(opts: {
  brainId: string;
  noteId: string;
  title: string;
  body: string;
  folderId?: string | null;
  /** Stage 4 token attribution for project direct-writes / reviewer edits. */
  tokenId?: string | null;
}): Promise<Note | null> {
  if (!isUuid(opts.brainId) || !isUuid(opts.noteId)) return null;
  if (opts.folderId && !isUuid(opts.folderId)) throw new Error("Folder is in another base.");
  if (opts.tokenId && !isUuid(opts.tokenId)) throw new Error("Base not found.");
  if (opts.folderId) {
    const f = await folderInBrain(opts.folderId, opts.brainId);
    if (!f) throw new Error("Folder is in another base.");
  }
  return tx(async (client) => {
    // Active-only at the boundary: pending proposals are reviewer-only and
    // proposal editing lands in stage 4 (reviewer-gated, see svod-proposals).
    const cur = await client.query<{ id: string; title: string; body: string; folder_id: string | null }>(
      `select id, title, body, folder_id from notes
        where id = $1 and brain_id = $2 and status = 'active' for update`,
      [opts.noteId, opts.brainId],
    );
    if (!cur.rowCount) return { note: null, queued: false };
    const current = cur.rows[0];
    // HTML forms normalise every newline variant (CR, LF, CRLF) to CRLF on
    // submit: compare normalised, but keep the exact stored bytes when the text
    // is unchanged — including title-only edits. A true no-op touches nothing,
    // so vectors and chunk IDs survive.
    const bodyUnchanged = normForCompare(current.body) === normForCompare(opts.body);
    const titleUnchanged = current.title === opts.title;
    const folderUnchanged = opts.folderId === undefined || (current.folder_id ?? null) === (opts.folderId ?? null);
    if (bodyUnchanged && titleUnchanged && folderUnchanged && !opts.tokenId) {
      const same = await client.query<Note>(
        `select * from notes where id = $1 and brain_id = $2 and status = 'active'`,
        [opts.noteId, opts.brainId],
      );
      return { note: same.rows[0] ?? null, queued: false };
    }
    // No-op content but token attribution requested (project touch): still
    // stamp updated_token_id/updated_at without rewriting chunks.
    if (bodyUnchanged && titleUnchanged && folderUnchanged && opts.tokenId) {
      const rows = await client.query<Note>(
        `update notes set updated_token_id = $3 where id = $1 and brain_id = $2 and status = 'active' returning *`,
        [opts.noteId, opts.brainId, opts.tokenId],
      );
      return { note: rows.rows[0] ?? null, queued: false };
    }
    const nextBody = bodyUnchanged ? current.body : opts.body;
    const nextFolder = opts.folderId === undefined ? current.folder_id : opts.folderId;
    if (nextFolder) {
      const lock = await client.query(`select id from folders where id = $1 and brain_id = $2 for update`, [
        nextFolder,
        opts.brainId,
      ]);
      if (!lock.rowCount) throw new Error("Folder is in another base.");
    }
    const rows = await client.query<Note>(
      `update notes set title = $3, body = $4, folder_id = $5, updated_token_id = $6
        where id = $1 and brain_id = $2 and status = 'active' returning *`,
      [opts.noteId, opts.brainId, opts.title, nextBody, nextFolder, opts.tokenId ?? null],
    );
    const note = rows.rows[0];
    if (!note) return { note: null, queued: false };
    // Title and/or body changed → sections reconciled atomically in the same
    // tx (unchanged hashes keep their chunk id and compatible vector; section
    // deletes — delete from chunks — happen inside syncSvodSections).
    // Folder-only moves keep chunks (handled here too when body/title unchanged
    // but folder changed: chunks untouched below? No — folder change alone does
    // not need chunk rewrite, but rewriting to identical content is harmless
    // and keeps the "chunks match final content exactly" invariant. To preserve
    // chunk IDs on pure moves, skip rewrite when only folder changed.
    const contentChanged = !bodyUnchanged || !titleUnchanged;
    let queued = false;
    if (contentChanged) {
      try {
        const sync = await syncSvodSections(client, {
          brainId: opts.brainId,
          noteId: opts.noteId,
          title: opts.title,
          body: nextBody,
        });
        queued = sync.queued;
      } catch {
        await client.query(`delete from chunks where note_id = $1`, [opts.noteId]);
        await insertLexicalChunks(client, opts.brainId, opts.noteId, opts.title, nextBody);
      }
    }
    await client.query(`update brains set content_changed_at = now() where id = $1`, [opts.brainId]);
    return { note, queued };
  }).then(async (out) => {
    if (out.queued) await wakeSvodIndexer().catch(() => {});
    return out.note;
  });
}

export async function moveSvodNote(opts: {
  brainId: string;
  folderId: string | null;
  noteId: string;
}): Promise<boolean> {
  if (!isUuid(opts.brainId) || !isUuid(opts.noteId)) return false;
  if (opts.folderId && !isUuid(opts.folderId)) throw new Error("Folder is in another base.");
  if (opts.folderId) {
    const f = await folderInBrain(opts.folderId, opts.brainId);
    if (!f) throw new Error("Folder is in another base.");
  }
  return tx(async (client) => {
    if (opts.folderId) {
      const lock = await client.query(`select id from folders where id = $1 and brain_id = $2 for update`, [
        opts.folderId,
        opts.brainId,
      ]);
      if (!lock.rowCount) throw new Error("Folder is in another base.");
    }
    // Active-only: moving a pending proposal is not a normal content op.
    // Vectors/chunks untouched (body unchanged).
    const res = await client.query(
      `update notes set folder_id = $3 where id = $1 and brain_id = $2 and status = 'active'`,
      [opts.noteId, opts.brainId, opts.folderId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

export async function deleteSvodNote(brainId: string, noteId: string): Promise<boolean> {
  if (!isUuid(brainId) || !isUuid(noteId)) return false;
  return tx(async (client) => {
    // Active-only at the boundary: pending proposals stay reviewer-only.
    const cur = await client.query(
      `select id from notes where id = $1 and brain_id = $2 and status = 'active' for update`,
      [noteId, brainId],
    );
    if (!cur.rowCount) return false;
    // Explicit chunk delete first so body/status/search stay in sync even if a
    // future FK changes; the FK cascade is the backstop.
    await client.query(`delete from chunks where note_id = $1`, [noteId]);
    const res = await client.query(
      `delete from notes where id = $1 and brain_id = $2 and status = 'active'`,
      [noteId, brainId],
    );
    if ((res.rowCount ?? 0) > 0) {
      await client.query(`update brains set content_changed_at = now() where id = $1`, [brainId]);
      return true;
    }
    return false;
  });
}

export interface SvodSearchHit {
  note_id: string;
  title: string;
  folder_id: string | null;
  folder_path?: string;
  excerpt: string;
  rank: number;
  via?: "vector" | "text" | "both";
  brain_id?: string;
  brain_slug?: string;
  brain_title?: string;
}

const SVOD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SVOD_CANDIDATES = 30;
const SVOD_RRF_K = 60;

async function svodFolderPaths(
  brainId: string,
  folderIds: (string | null)[],
): Promise<Map<string, string>> {
  const { query: q2 } = await import("@/db");
  const { folderPath } = await import("@/lib/svod-folders");
  const folders = await q2<{ id: string; parent_id: string | null; name: string; brain_id: string }>(
    `select id, parent_id, name, brain_id from folders where brain_id = $1`,
    [brainId],
  ).catch(() => []);
  const full = folders.map((f) => ({ id: f.id, brain_id: f.brain_id, parent_id: f.parent_id, name: f.name, created_at: new Date(0), updated_at: new Date(0) }));
  const out = new Map<string, string>();
  for (const fid of folderIds) {
    if (!fid) continue;
    if (!out.has(fid)) out.set(fid, folderPath(full, fid));
  }
  return out;
}

/**
 * Workspace + Svod hybrid search (no reranker, no paid LLM).
 *
 * - Exact UUID of an active note in this base returns it with its folder
 *   path and never touches the embed service (even when it is down).
 * - Otherwise the lexical leg (as before) plus a vector leg over
 *   `ready` chunks whose fingerprint equals the current confirmed id on
 *   both endpoints. Dead service / unconfirmed / mismatched fingerprints:
 *   lexical only, no exception. Pending never matches.
 * - Fusion is RRF, then per-note dedup BEFORE the limit, so one note with
 *   several good chunks cannot crowd out another note.
 */
export async function searchSvodNotes(
  brainId: string,
  q: string,
  limit = 20,
): Promise<SvodSearchHit[]> {
  if (!isUuid(brainId)) return [];
  const text = q.trim().slice(0, 200);
  if (!text) return [];
  const n = Math.min(Math.max(limit, 1), 50);

  // Exact-ID shortcut: no embedding, even when the service is down.
  if (SVOD_UUID_RE.test(text)) {
    const note = await getSvodNote(brainId, text).catch(() => null);
    if (!note) return [];
    const paths = await svodFolderPaths(brainId, [note.folder_id]).catch(() => new Map());
    return [
      {
        note_id: note.id,
        title: note.title,
        folder_id: note.folder_id,
        folder_path: note.folder_id ? (paths.get(note.folder_id) ?? "") : "",
        excerpt: note.body.slice(0, 220),
        rank: 1,
        via: "text",
        brain_id: brainId,
      },
    ];
  }

  const tsq = toTsQuery(text);
  if (!tsq) return [];

  // Lexical leg (same shape as before: per-note best BEFORE the limit).
  const lexRows = await query<{
    note_id: string;
    title: string;
    folder_id: string | null;
    excerpt: string;
    rank: string;
    chunk_id: string;
  }>(
    `with ranked as (
       select n.id as note_id, n.title, n.folder_id, c.id as chunk_id,
              left(c.content, 220) as excerpt,
              ts_rank_cd(c.tsv, to_tsquery('simple', $2)) as rank,
              row_number() over (
                partition by n.id
                order by ts_rank_cd(c.tsv, to_tsquery('simple', $2)) desc
              ) as rn
         from chunks c
         join notes n on n.id = c.note_id
        where c.brain_id = $1
          and n.brain_id = $1
          and n.status = 'active'
          and c.tsv @@ to_tsquery('simple', $2)
     )
     select note_id, title, folder_id, chunk_id, excerpt, rank::text as rank
       from ranked
      where rn = 1
      order by rank desc
      limit $3`,
    [brainId, tsq, Math.max(n, SVOD_CANDIDATES)],
  ).catch(() => []);

  // Vector leg: ready chunks with the current confirmed fingerprint only.
  // Old (NULL/foreign) vectors stay lexical-only; pending never matches.
  let vecRows: { chunk_id: string; note_id: string; title: string; folder_id: string | null; excerpt: string }[] = [];
  let queryVec: number[] | null = null;
  let fpId: string | null = null;
  try {
    const { getSvodEmbedState, embedSvodQuery } = await import("@/lib/embed");
    const st = await getSvodEmbedState();
    if (st.usable && st.fingerprintId) {
      fpId = st.fingerprintId;
      const v = await embedSvodQuery(text);
      queryVec = v;
    }
  } catch {
    queryVec = null;
  }
  if (queryVec && fpId) {
    try {
      const { toVector } = await import("@/db");
      // One best chunk per note BEFORE the limit — same rule as the lexical
      // leg — so a note with several close sections cannot crowd other notes
      // out of the candidate set.
      const ranked = await query<{ chunk_id: string; note_id: string; title: string; folder_id: string | null; excerpt: string }>(
        `with ranked as (
           select c.id as chunk_id, c.note_id, n.title, n.folder_id,
                  left(c.content, 220) as excerpt,
                  c.embedding <=> $3::halfvec as dist,
                  row_number() over (
                    partition by n.id
                    order by c.embedding <=> $3::halfvec
                  ) as rn
             from chunks c
             join notes n on n.id = c.note_id
            where c.brain_id = $1
              and n.brain_id = $1
              and n.status = 'active'
              and c.embed_state = 'ready'
              and c.embed_fingerprint = $2
              and c.embedding is not null
         )
         select chunk_id, note_id, title, folder_id, excerpt
           from ranked
          where rn = 1
          order by dist
          limit ${SVOD_CANDIDATES}`,
        [brainId, fpId, toVector(queryVec)],
      );
      // Belt and braces: keep the best chunk per note even if a stubbed or
      // future transport returns several rows for one note.
      const bestByNote = new Map<string, (typeof ranked)[number]>();
      for (const r of ranked) {
        if (!bestByNote.has(r.note_id)) bestByNote.set(r.note_id, r);
      }
      vecRows = [...bestByNote.values()];
    } catch {
      vecRows = [];
    }
  }

  if (!vecRows.length) {
    // Lexical-only (dead service, unconfirmed/mismatched fp, or no vectors).
    const paths = await svodFolderPaths(
      brainId,
      lexRows.map((r) => r.folder_id),
    ).catch(() => new Map());
    return lexRows.slice(0, n).map((r) => ({
      note_id: r.note_id,
      title: r.title,
      folder_id: r.folder_id,
      folder_path: r.folder_id ? (paths.get(r.folder_id) ?? "") : "",
      excerpt: r.excerpt,
      rank: Number(r.rank),
      via: "text" as const,
      brain_id: brainId,
    }));
  }

  // RRF fusion across the two legs, then per-note dedup BEFORE the limit.
  const scores = new Map<string, { score: number; inVec: boolean; inLex: boolean; row: { note_id: string; title: string; folder_id: string | null; excerpt: string } }>();
  lexRows.forEach((r, idx) => {
    const s = 1 / (SVOD_RRF_K + idx + 1);
    const cur = scores.get(r.note_id);
    if (cur) {
      cur.score += s;
      cur.inLex = true;
    } else {
      scores.set(r.note_id, { score: s, inVec: false, inLex: true, row: r });
    }
  });
  vecRows.forEach((r, idx) => {
    const s = 1 / (SVOD_RRF_K + idx + 1);
    const cur = scores.get(r.note_id);
    if (cur) {
      cur.score += s;
      cur.inVec = true;
    } else {
      scores.set(r.note_id, { score: s, inVec: true, inLex: false, row: r });
    }
  });
  const fused = [...scores.entries()]
    .map(([note_id, v]) => ({ note_id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  const paths = await svodFolderPaths(
    brainId,
    fused.map((f) => f.row.folder_id),
  ).catch(() => new Map());
  return fused.map((f) => ({
    note_id: f.note_id,
    title: f.row.title,
    folder_id: f.row.folder_id,
    folder_path: f.row.folder_id ? (paths.get(f.row.folder_id) ?? "") : "",
    excerpt: f.row.excerpt,
    rank: f.score,
    via: (f.inVec && f.inLex ? "both" : f.inVec ? "vector" : "text") as "vector" | "text" | "both",
    brain_id: brainId,
  }));
}

/**
 * Multi-base Svod search for MCP (project-first callers sort afterwards).
 * Scope is the already-intersected user ∩ token set — never opens a foreign
 * base here. Exact UUIDs avoid embeddings; otherwise the same hybrid rule as
 * the workspace path, with brain + folder provenance on every hit.
 *
 * When `opts.category` is set, both legs filter exactly like `searchBrain`:
 * exact `lower(notes.category)` or the `category || '/%'` subtree. Without
 * it no category filter applies.
 */
export async function searchSvodScope(
  brainIds: string[],
  q: string,
  limit = 8,
  opts?: { category?: string | null },
): Promise<SvodSearchHit[]> {
  const ids = [...new Set(brainIds.filter((b) => isUuid(b)))];
  if (!ids.length) return [];
  const text = q.trim().slice(0, 200);
  if (!text) return [];
  const n = Math.min(Math.max(limit, 1), 25);
  // Normalised exactly like searchBrain, so "Type scale" still finds notes
  // filed as "type scale"; null disables the filter.
  const category = normalizeCategory(opts?.category);

  if (SVOD_UUID_RE.test(text)) {
    const row = await maybeOne<{ id: string; brain_id: string; title: string; body: string; folder_id: string | null }>(
      `select id, brain_id, title, body, folder_id from notes
        where id = $1 and brain_id = any($2::uuid[]) and status = 'active'`,
      [text, ids],
    ).catch(() => null);
    if (!row) return [];
    const brain = await maybeOne<{ slug: string; title: string }>(
      `select slug, title from brains where id = $1`,
      [row.brain_id],
    ).catch(() => null);
    let folderPath = "";
    try {
      const { query: q2 } = await import("@/db");
      const { folderPath: fp } = await import("@/lib/svod-folders");
      const folders = await q2<{ id: string; parent_id: string | null; name: string; brain_id: string }>(
        `select id, parent_id, name, brain_id from folders where brain_id = $1`,
        [row.brain_id],
      );
      const full = folders.map((f) => ({ id: f.id, brain_id: f.brain_id, parent_id: f.parent_id, name: f.name, created_at: new Date(0), updated_at: new Date(0) }));
      folderPath = row.folder_id ? fp(full, row.folder_id) : "";
    } catch {
      folderPath = "";
    }
    return [
      {
        note_id: row.id,
        title: row.title,
        folder_id: row.folder_id,
        folder_path: folderPath,
        excerpt: row.body.slice(0, 220),
        rank: 1,
        via: "text",
        brain_id: row.brain_id,
        brain_slug: brain?.slug ?? "",
        brain_title: brain?.title ?? "",
      },
    ];
  }

  const tsq = toTsQuery(text);
  if (!tsq) return [];

  const lexRows = await query<{
    note_id: string;
    brain_id: string;
    title: string;
    folder_id: string | null;
    excerpt: string;
    rank: string;
  }>(
    `with ranked as (
       select n.id as note_id, n.brain_id, n.title, n.folder_id,
              left(c.content, 220) as excerpt,
              ts_rank_cd(c.tsv, to_tsquery('simple', $2)) as rank,
              row_number() over (
                partition by n.id
                order by ts_rank_cd(c.tsv, to_tsquery('simple', $2)) desc
              ) as rn
         from chunks c
         join notes n on n.id = c.note_id
        where c.brain_id = any($1::uuid[])
          and n.brain_id = any($1::uuid[])
          and n.status = 'active'
          and c.tsv @@ to_tsquery('simple', $2)
          and ($4::text is null
               or lower(n.category) = $4
               or lower(n.category) like $4 || '/%')
     )
     select note_id, brain_id, title, folder_id, excerpt, rank::text as rank
       from ranked
      where rn = 1
      order by rank desc
      limit $3`,
    [ids, tsq, Math.max(n, SVOD_CANDIDATES), category],
  ).catch(() => []);

  let vecRows: { note_id: string; brain_id: string; title: string; folder_id: string | null; excerpt: string }[] = [];
  try {
    const { getSvodEmbedState, embedSvodQuery } = await import("@/lib/embed");
    const st = await getSvodEmbedState();
    if (st.usable && st.fingerprintId) {
      const v = await embedSvodQuery(text);
      const { toVector } = await import("@/db");
      // One best chunk per note BEFORE the limit — same rule as the lexical
      // leg — so a note with several close sections cannot crowd other notes
      // out of the candidate set.
      const ranked = await query<{ chunk_id: string; note_id: string; brain_id: string; title: string; folder_id: string | null; excerpt: string }>(
        `with ranked as (
           select c.id as chunk_id, c.note_id, n.brain_id, n.title, n.folder_id,
                  left(c.content, 220) as excerpt,
                  c.embedding <=> $3::halfvec as dist,
                  row_number() over (
                    partition by n.id
                    order by c.embedding <=> $3::halfvec
                  ) as rn
             from chunks c
             join notes n on n.id = c.note_id
            where c.brain_id = any($1::uuid[])
              and n.brain_id = any($1::uuid[])
              and n.status = 'active'
              and c.embed_state = 'ready'
              and c.embed_fingerprint = $2
              and c.embedding is not null
              and ($4::text is null
                   or lower(n.category) = $4
                   or lower(n.category) like $4 || '/%')
         )
         select chunk_id, note_id, brain_id, title, folder_id, excerpt
           from ranked
          where rn = 1
          order by dist
          limit ${SVOD_CANDIDATES}`,
        [ids, st.fingerprintId, toVector(v), category],
      );
      // Belt and braces: keep the best chunk per note even if a stubbed or
      // future transport returns several rows for one note.
      const bestByNote = new Map<string, (typeof ranked)[number]>();
      for (const r of ranked) {
        if (!bestByNote.has(r.note_id)) bestByNote.set(r.note_id, r);
      }
      vecRows = [...bestByNote.values()];
    }
  } catch {
    vecRows = [];
  }

  const scores = new Map<string, { score: number; inVec: boolean; inLex: boolean; row: { note_id: string; brain_id: string; title: string; folder_id: string | null; excerpt: string } }>();
  lexRows.forEach((r, idx) => {
    const s = 1 / (SVOD_RRF_K + idx + 1);
    const cur = scores.get(r.note_id);
    if (cur) {
      cur.score += s;
      cur.inLex = true;
    } else {
      scores.set(r.note_id, { score: s, inVec: false, inLex: true, row: r });
    }
  });
  vecRows.forEach((r, idx) => {
    const s = 1 / (SVOD_RRF_K + idx + 1);
    const cur = scores.get(r.note_id);
    if (cur) {
      cur.score += s;
      cur.inVec = true;
    } else {
      scores.set(r.note_id, { score: s, inVec: true, inLex: false, row: r });
    }
  });
  if (!scores.size) return [];
  const fused = [...scores.entries()]
    .map(([note_id, v]) => ({ note_id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

  // Provenance: brain slug/title + folder path per hit (same token boundary:
  // every hit already comes from the allowed scope only).
  let brains: { id: string; slug: string; title: string }[] = [];
  let folders: { id: string; parent_id: string | null; name: string; brain_id: string }[] = [];
  try {
    const { query: q2 } = await import("@/db");
    brains = await q2(`select id, slug, title from brains where id = any($1::uuid[])`, [ids]);
    folders = await q2(`select id, parent_id, name, brain_id from folders where brain_id = any($1::uuid[])`, [ids]);
  } catch {
    brains = [];
    folders = [];
  }
  const brainById = new Map(brains.map((b) => [b.id, b]));
  const { folderPath: fp } = await import("@/lib/svod-folders").catch(() => ({ folderPath: () => "" as string }));
  const foldersByBrain = new Map<string, { id: string; brain_id: string; parent_id: string | null; name: string; created_at: Date; updated_at: Date }[]>();
  for (const f of folders) {
    const list = foldersByBrain.get(f.brain_id) ?? [];
    list.push({ id: f.id, brain_id: f.brain_id, parent_id: f.parent_id, name: f.name, created_at: new Date(0), updated_at: new Date(0) });
    foldersByBrain.set(f.brain_id, list);
  }
  return fused.map((f) => {
    const b = brainById.get(f.row.brain_id);
    const fl = foldersByBrain.get(f.row.brain_id) ?? [];
    return {
      note_id: f.note_id,
      title: f.row.title,
      folder_id: f.row.folder_id,
      folder_path: f.row.folder_id ? fp(fl, f.row.folder_id) : "",
      excerpt: f.row.excerpt,
      rank: f.score,
      via: (f.inVec && f.inLex ? "both" : f.inVec ? "vector" : "text") as "vector" | "text" | "both",
      brain_id: f.row.brain_id,
      brain_slug: b?.slug ?? "",
      brain_title: b?.title ?? "",
    };
  });
}

/** Normal reading: active notes only, same base, UUID-validated. */
export async function getSvodNote(
  brainId: string,
  noteId: string,
): Promise<Note | null> {
  if (!isUuid(brainId) || !isUuid(noteId)) return null;
  return maybeOne<Note>(
    `select * from notes where id = $1 and brain_id = $2 and status = 'active'`,
    [noteId, brainId],
  );
}

/** Reviewer-only reading: pending proposals, same base, UUID-validated. */
export async function getPendingSvodNote(
  brainId: string,
  noteId: string,
): Promise<Note | null> {
  if (!isUuid(brainId) || !isUuid(noteId)) return null;
  return maybeOne<Note>(
    `select * from notes where id = $1 and brain_id = $2 and status = 'pending'`,
    [noteId, brainId],
  );
}

/**
 * SVOD stage 4 project direct-write: trusted distinct path from proposals.
 *
 * - Base classification comes from DB (brains.project_id), never caller input:
 *   a general base is denied even with a forged write flag.
 * - Exact text preserved (BOM/CRLF/whitespace/fences, file links untouched);
 *   NUL rejected. Immediately readable after save (active + lexical chunks in
 *   the same transaction; embeddings NULL for stage 5).
 * - Reuses Stage 3 chunk operations safely (chunksForNote/estimateTokens).
 * - Token attribution (token_id/updated_token_id) survives soft revocation.
 */
export async function createProjectNoteDirect(opts: {
  brainId: string;
  folderId: string | null;
  title: string;
  body: string;
  tokenId: string;
}): Promise<Note> {
  if (!isUuid(opts.brainId) || !isUuid(opts.tokenId)) throw new Error("Base not found.");
  const brain = await maybeOne<{ id: string; project_id: string | null }>(
    `select id, project_id from brains where id = $1`,
    [opts.brainId],
  );
  if (!brain || !brain.project_id) throw new Error("Direct write is for project bases only.");
  return createSvodNote({
    brainId: opts.brainId,
    folderId: opts.folderId,
    title: opts.title,
    body: opts.body,
    tokenId: opts.tokenId,
    author: "agent",
    agentClient: "mcp",
  });
}

export async function updateProjectNoteDirect(opts: {
  brainId: string;
  noteId: string;
  title: string;
  body: string;
  folderId?: string | null;
  tokenId: string;
}): Promise<Note | null> {
  if (!isUuid(opts.brainId) || !isUuid(opts.noteId) || !isUuid(opts.tokenId)) return null;
  const brain = await maybeOne<{ id: string; project_id: string | null }>(
    `select id, project_id from brains where id = $1`,
    [opts.brainId],
  );
  // Trusted: general bases never direct-write, even with a forged scope flag.
  if (!brain || !brain.project_id) return null;
  return updateSvodNote({
    brainId: opts.brainId,
    noteId: opts.noteId,
    title: opts.title,
    body: opts.body,
    folderId: opts.folderId,
    tokenId: opts.tokenId,
  });
}
