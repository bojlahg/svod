import { pool, tx, toVector } from "@/db";
import type { Note } from "@/db/types";
import { chunksForNote, estimateTokens } from "@/lib/chunk";
import { embedPassages } from "@/lib/embed";

/**
 * Turning a pending note into a searchable one.
 *
 * This is where "review required" stops being a label: a note written by an
 * agent has no chunks until it is approved, and search runs over chunks. The
 * web action and the CLI both call this, so approving in bulk from a terminal
 * cannot drift from approving one in the browser.
 *
 * Atomic: the pending→active flip, the chunk inserts and the index metadata
 * land in one transaction guarded by `where status = 'pending'`. Two
 * simultaneous approvals of the same note resolve to exactly one activation —
 * the loser sees zero rows flipped and writes nothing (no duplicate chunks).
 */
export async function approve(note: Note): Promise<boolean> {
  const texts = chunksForNote(note.title, note.body);

  // Embed before flipping status. If the embedder is down the note stays
  // pending — an "active" note with no chunks is invisible to search, which
  // looks like the approval silently did nothing.
  const vectors = await embedPassages(texts);

  return tx(async (client) => {
    const flipped = await client.query(
      `update notes set status = 'active' where id = $1 and status = 'pending'`,
      [note.id],
    );
    if ((flipped.rowCount ?? 0) === 0) return false;
    for (let i = 0; i < texts.length; i++) {
      await client.query(
        `insert into chunks (brain_id, note_id, content, token_count, embedding)
         values ($1, $2, $3, $4, $5::halfvec)`,
        [note.brain_id, note.id, texts[i], estimateTokens(texts[i]), toVector(vectors[i])],
      );
    }
    await client.query(`update brains set content_changed_at = now() where id = $1`, [
      note.brain_id,
    ]);
    return true;
  });
}

export async function reject(noteId: string): Promise<boolean> {
  // Only pending notes may be rejected: two simultaneous rejects, or a
  // reject racing an approval, resolve to exactly one state change.
  const res = await pool.query(
    `update notes set status = 'rejected' where id = $1 and status = 'pending'`,
    [noteId],
  );
  return (res.rowCount ?? 0) > 0;
}
