import { pool, tx } from "@/db";
import type { Note } from "@/db/types";
import { chunksForNote, estimateTokens } from "@/lib/chunk";

/**
 * Turning a pending note into a searchable one.
 *
 * SVOD stage 3: lexical-first. Approval flips pending→active and writes
 * searchable lexical chunks transactionally with the current chunk utilities;
 * embeddings stay NULL (pending) for stage 5. No embed service, no paid LLM —
 * approving while the embedder is down still publishes a searchable note.
 *
 * Atomic: the pending→active flip, the chunk inserts and the index metadata
 * land in one transaction guarded by `where status = 'pending'`. Two
 * simultaneous approvals of the same note resolve to exactly one activation —
 * the loser sees zero rows flipped and writes nothing (no duplicate chunks).
 */
export async function approve(note: Note): Promise<boolean> {
  const texts = chunksForNote(note.title, note.body);

  return tx(async (client) => {
    const flipped = await client.query(
      `update notes set status = 'active' where id = $1 and status = 'pending'`,
      [note.id],
    );
    if ((flipped.rowCount ?? 0) === 0) return false;
    for (let i = 0; i < texts.length; i++) {
      await client.query(
        `insert into chunks (brain_id, note_id, content, token_count, embedding)
         values ($1, $2, $3, $4, null)`,
        [note.brain_id, note.id, texts[i], estimateTokens(texts[i])],
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
