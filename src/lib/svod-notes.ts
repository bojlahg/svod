import { maybeOne, query, tx } from "@/db";
import type { PoolClient } from "pg";
import type { Note } from "@/db/types";
import { chunksForNote, estimateTokens } from "@/lib/chunk";
import { toTsQuery } from "@/lib/tsquery";
import { folderInBrain, isUuid } from "@/lib/svod-folders";

/**
 * SVOD stage 3 note writes: Markdown-only, no paid LLM, no embeddings required.
 *
 * - Original bytes preserved: validate/store return the exact input string
 *   (BOM/CRLF/whitespace/fences untouched). Blank means whitespace-only, but
 *   the stored body is never trimmed. NUL is rejected (it truncates in PG).
 * - New/edited ACTIVE notes get searchable lexical chunks transactionally with
 *   the current chunk utilities (chunksForNote/estimateTokens). Embeddings are
 *   left NULL (pending) for stage 5 — lexical search (tsv) works today, vector
 *   search reuses the stored vectors later.
 * - Unchanged saves are no-ops: same title + same body (modulo textarea CRLF
 *   normalisation) keeps the row, the vectors and the chunk IDs untouched.
 * - Moves keep IDs and vectors: only folder_id changes, chunks untouched.
 * - Pending proposals never get chunks here and never appear in search/tree;
 *   proposal editing lands in stage 4. All normal mutations and reads below
 *   are active-only at the SQL boundary.
 * - Body/status and search stay in sync: chunk rewrites happen in the same
 *   transaction as the note change.
 */

export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BODY = 100_000;
export const MAX_MD_UPLOAD_BYTES = 200 * 1024;

const normForCompare = (s: string): string => s.replace(/\r\n/g, "\n");

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
}): Promise<Note> {
  if (!isUuid(opts.brainId)) throw new Error("Base not found.");
  if (opts.folderId && !isUuid(opts.folderId)) throw new Error("Folder is in another base.");
  if (opts.folderId) {
    const f = await folderInBrain(opts.folderId, opts.brainId);
    if (!f) throw new Error("Folder is in another base.");
  }
  return tx(async (client) => {
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
      `insert into notes (brain_id, folder_id, title, body, author, status)
       values ($1, $2, $3, $4, 'human', 'active')
       returning *`,
      [opts.brainId, opts.folderId, opts.title, opts.body],
    );
    const note = rows.rows[0];
    await insertLexicalChunks(client, opts.brainId, note.id, opts.title, opts.body);
    await client.query(`update brains set content_changed_at = now() where id = $1`, [opts.brainId]);
    return note;
  });
}

export async function updateSvodNote(opts: {
  brainId: string;
  noteId: string;
  title: string;
  body: string;
}): Promise<Note | null> {
  if (!isUuid(opts.brainId) || !isUuid(opts.noteId)) return null;
  return tx(async (client) => {
    // Active-only at the boundary: pending proposals are reviewer-only and
    // proposal editing lands in stage 4.
    const cur = await client.query<{ id: string; title: string; body: string }>(
      `select id, title, body from notes
        where id = $1 and brain_id = $2 and status = 'active' for update`,
      [opts.noteId, opts.brainId],
    );
    if (!cur.rowCount) return null;
    const current = cur.rows[0];
    // Textareas normalise CRLF to LF on submit: compare normalised, but keep
    // the exact stored bytes when the text is unchanged — including title-only
    // edits. A true no-op touches nothing, so vectors and chunk IDs survive.
    const bodyUnchanged = normForCompare(current.body) === normForCompare(opts.body);
    const titleUnchanged = current.title === opts.title;
    if (bodyUnchanged && titleUnchanged) {
      const same = await client.query<Note>(
        `select * from notes where id = $1 and brain_id = $2 and status = 'active'`,
        [opts.noteId, opts.brainId],
      );
      return same.rows[0] ?? null;
    }
    const nextBody = bodyUnchanged ? current.body : opts.body;
    const rows = await client.query<Note>(
      `update notes set title = $3, body = $4 where id = $1 and brain_id = $2 and status = 'active' returning *`,
      [opts.noteId, opts.brainId, opts.title, nextBody],
    );
    const note = rows.rows[0];
    if (!note) return null;
    // Title and/or body changed → chunks rewritten atomically (old vectors drop
    // with the old chunks; new chunks are lexical-first, embeddings pending).
    await client.query(`delete from chunks where note_id = $1`, [opts.noteId]);
    await insertLexicalChunks(client, opts.brainId, opts.noteId, opts.title, nextBody);
    await client.query(`update brains set content_changed_at = now() where id = $1`, [opts.brainId]);
    return note;
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
  excerpt: string;
  rank: number;
}

/**
 * Lexical-only search for the workspace: no embeddings, no reranker, no paid
 * LLM. Pending proposals never match (status filter). Old vectors are never
 * touched by reading. Deduplicated per note BEFORE the limit, so one note with
 * several good chunks cannot crowd out another note.
 */
export async function searchSvodNotes(
  brainId: string,
  q: string,
  limit = 20,
): Promise<SvodSearchHit[]> {
  if (!isUuid(brainId)) return [];
  const text = q.trim().slice(0, 200);
  if (!text) return [];
  const tsq = toTsQuery(text);
  if (!tsq) return [];
  const n = Math.min(Math.max(limit, 1), 50);
  const rows = await query<{
    note_id: string;
    title: string;
    folder_id: string | null;
    excerpt: string;
    rank: string;
  }>(
    `with ranked as (
       select n.id as note_id, n.title, n.folder_id,
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
     select note_id, title, folder_id, excerpt, rank::text as rank
       from ranked
      where rn = 1
      order by rank desc
      limit $3`,
    [brainId, tsq, n],
  );
  return rows.slice(0, n).map((r) => ({
    note_id: r.note_id,
    title: r.title,
    folder_id: r.folder_id,
    excerpt: r.excerpt,
    rank: Number(r.rank),
  }));
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
