import { tx } from "@/db";
import type { Note } from "@/db/types";
import { folderInBrain, isUuid } from "@/lib/svod-folders";
import { syncSvodSections, wakeSvodIndexer } from "@/lib/svod-index";

/**
 * Stage3 newline semantics: compare with every HTML-normalized newline variant
 * folded (CRLF and lone CR, old Mac endings, all arrive as CRLF on form
 * submit), but store the original string untouched. Browsers normalize lone LF
 * and lone CR to CRLF on HTML form submit (textarea/hidden), so a reviewer save
 * with no real edits must not rewrite the stored BOM+LF (or lone-CR) bytes —
 * while genuine content changes still use the submitted text.
 */
const normForCompare = (s: string): string => s.replace(/\r\n?/g, "\n");

/** Original stored bytes when the submission differs only by form normalization. */
function preservedBody(stored: string, submitted: string): string {
  return normForCompare(submitted) === normForCompare(stored) ? stored : submitted;
}

/**
 * SVOD stage 4 general-base proposals: token-attributed pending notes.
 *
 * - New-note proposals and existing-note edit proposals both land pending,
 *   preserving the current accepted note unchanged and searchable until manual
 *   approval.
 * - No eager embedding / paid LLM / old extraction on save: pending proposals
 *   get no chunks (search stays active-only), embeddings stay NULL for stage 5.
 * - Edit proposals reference target note UUID (target_note_id, composite FK
 *   (brain_id, target_note_id) -> notes (brain_id, id)) + target_revision
 *   (target.revision integer at proposal time) for exact stale-target detection.
 *   Integer revision is the authority: timestamps lose sub-second precision in
 *   node-pg and String(Date) comparisons.
 * - Pending proposals carry their own revision (bumped on every UPDATE via
 *   trigger). Approve/edit guard on expected proposal revision + source brain
 *   at the transaction boundary so a stale reviewer view cannot approve unseen
 *   content.
 * - Token attribution (token_id, proposed_by) survives soft revocation.
 * - Trusted distinct path from project direct-writes: this module never writes
 *   active notes directly except via reviewer approval below.
 */

export async function proposeNewNote(opts: {
  brainId: string;
  folderId: string | null;
  title: string;
  body: string;
  userId: string;
  tokenId: string;
}): Promise<Note> {
  if (!isUuid(opts.brainId) || !isUuid(opts.tokenId)) throw new Error("Base not found.");
  if (opts.folderId && !isUuid(opts.folderId)) throw new Error("Folder is in another base.");
  if (opts.folderId) {
    const f = await folderInBrain(opts.folderId, opts.brainId);
    if (!f) throw new Error("Folder is in another base.");
  }
  return tx(async (client) => {
    await client.query(`select id from brains where id = $1 for update`, [opts.brainId]);
    if (opts.folderId) {
      const lock = await client.query(`select id from folders where id = $1 and brain_id = $2 for update`, [
        opts.folderId,
        opts.brainId,
      ]);
      if (!lock.rowCount) throw new Error("Folder is in another base.");
    }
    const rows = await client.query<Note>(
      `insert into notes (brain_id, folder_id, title, body, author, agent_client, status, proposed_by, token_id, target_note_id)
       values ($1, $2, $3, $4, 'agent', 'mcp', 'pending', $5, $6, null)
       returning *`,
      [opts.brainId, opts.folderId, opts.title, opts.body, opts.userId, opts.tokenId],
    );
    await client.query(`update brains set content_changed_at = now() where id = $1`, [opts.brainId]);
    return rows.rows[0];
  });
}

export async function proposeEditNote(opts: {
  brainId: string;
  targetNoteId: string;
  title: string;
  body: string;
  userId: string;
  tokenId: string;
}): Promise<Note | null> {
  if (!isUuid(opts.brainId) || !isUuid(opts.targetNoteId) || !isUuid(opts.tokenId)) return null;
  return tx(async (client) => {
    // Target must be active IN THE PROPOSAL BASE; lock it to read exact revision.
    const target = await client.query<{ id: string; revision: number }>(
      `select id, revision from notes
        where id = $1 and brain_id = $2 and status = 'active' for update`,
      [opts.targetNoteId, opts.brainId],
    );
    if (!target.rowCount) return null;
    const revision = target.rows[0].revision;
    const rows = await client.query<Note>(
      `insert into notes (brain_id, folder_id, title, body, author, agent_client, status,
                          proposed_by, token_id, target_note_id, target_revision)
       values ($1,
               (select folder_id from notes where id = $2 and brain_id = $1),
               $3, $4, 'agent', 'mcp', 'pending', $5, $6, $2, $7)
       returning *`,
      [opts.brainId, opts.targetNoteId, opts.title, opts.body, opts.userId, opts.tokenId, revision],
    );
    await client.query(`update brains set content_changed_at = now() where id = $1`, [opts.brainId]);
    return rows.rows[0];
  });
}

export type EditProposalResult =
  | { ok: true; proposal: Note }
  | { ok: false; reason: string; current?: { title: string; body: string; revision: number } };

/**
 * Reviewer rebase/save: refresh a pending edit proposal onto the CURRENT
 * accepted revision so stale feedback can recover without losing reviewer work.
 *
 * REQUIRED guards (no unversioned fallback): expected proposal revision +
 * expected target revision as shown in the UI. Forged omission/malformed
 * versions are refused. New-note proposals pass expectedTargetRevision null.
 */
export async function editProposal(opts: {
  brainId: string;
  proposalId: string;
  title: string;
  body: string;
  expectedProposalRevision: number;
  expectedTargetRevision: number | null;
}): Promise<EditProposalResult> {
  const { brainId, proposalId: pid, title: t, body: b } = opts;
  if (!isUuid(brainId) || !isUuid(pid)) return { ok: false, reason: "Proposal not found." };
  if (!Number.isInteger(opts.expectedProposalRevision) || opts.expectedProposalRevision < 1) {
    return { ok: false, reason: "Stale view: reload the queue and resubmit the shown versions." };
  }
  if (opts.expectedTargetRevision !== null &&
      (!Number.isInteger(opts.expectedTargetRevision) || opts.expectedTargetRevision < 1)) {
    return { ok: false, reason: "Stale view: reload the queue and resubmit the shown versions." };
  }
  return tx(async (client) => {
    const cur = await client.query<Note>(
      `select * from notes where id = $1 and brain_id = $2 and status = 'pending' for update`,
      [pid, brainId],
    );
    if (!cur.rowCount) return { ok: false, reason: "Proposal is no longer pending." };
    const proposal = cur.rows[0];
    if (proposal.revision !== opts.expectedProposalRevision) {
      return {
        ok: false,
        reason:
          "This proposal changed after you opened it (another reviewer edited it). " +
          "Reload the queue and review the current proposal before saving.",
      };
    }
    if (proposal.target_note_id) {
      const target = await client.query<{ title: string; body: string; revision: number }>(
        `select title, body, revision from notes where id = $1 and brain_id = $2 and status = 'active'`,
        [proposal.target_note_id, brainId],
      );
      if (!target.rowCount) {
        return { ok: false, reason: "The original note is gone." };
      }
      if (opts.expectedTargetRevision !== null && target.rows[0].revision !== opts.expectedTargetRevision) {
        return {
          ok: false,
          reason:
            "The original note changed after you opened this proposal. " +
            "The current accepted version is shown; your draft is preserved below. " +
            "Rebase onto the current version and save again.",
          current: target.rows[0],
        };
      }
      // Browser forms normalize LF to CRLF on submit: keep the stored raw
      // bytes (BOM/LF/whitespace/fences) when nothing really changed.
      const saveBody = preservedBody(proposal.body, b);
      const rows = await client.query<Note>(
        `update notes set title = $3, body = $4, target_revision = $5
          where id = $1 and brain_id = $2 and status = 'pending'
          returning *`,
        [pid, brainId, t, saveBody, target.rows[0].revision],
      );
      return { ok: true, proposal: rows.rows[0] };
    }
    if (opts.expectedTargetRevision !== null) {
      return { ok: false, reason: "Stale view: reload the queue and resubmit the shown versions." };
    }
    const saveBody = preservedBody(proposal.body, b);
    const rows = await client.query<Note>(
      `update notes set title = $3, body = $4
        where id = $1 and brain_id = $2 and status = 'pending'
        returning *`,
      [pid, brainId, t, saveBody],
    );
    const updated = rows.rows[0] ?? null;
    if (!updated) return { ok: false, reason: "Proposal is no longer pending." };
    return { ok: true, proposal: updated };
  });
}

export type ApproveResult =
  | { ok: true; kind: "new" | "edit" | "moved-edit"; noteId: string }
  | { ok: false; reason: string; current?: { title: string; body: string; revision: number } };

/**
 * Apply an accepted proposal atomically, matching chunks to final content.
 *
 * Guards (transaction boundary):
 *   - expectedProposalRevision: the revision actually shown in the UI. A
 *     reviewer approval rendered before another reviewer edits/moves the
 *     proposal cannot approve unseen content.
 *   - expectedSourceBrainId: the source brain shown in the UI. Approval cannot
 *     silently cross scopes if the proposal moved.
 *   - target_revision vs current target.revision (integer equality): parallel
 *     accepted updates cannot be silently overwritten; the proposal REMAINS
 *     pending with readable feedback + current version for rebase.
 *
 * Destination behavior:
 *   - New-note: optional destination brain/folder (reviewer must hold review
 *     rights on both, checked by caller). Activates in the destination base.
 *   - Edit, same base: updates the SAME target ID (preserved), rewriting chunks
 *     exactly. Target reads are scoped to the proposal base
 *     (id + brain_id + active).
 *   - Edit with different destination: NEVER mutates the original target.
 *     Creates a clearly labeled NEW active note in the destination base and
 *     supersedes the proposal, preserving the original and other pending refs.
 */
export async function approveProposal(opts: {
  proposalId: string;
  title?: string;
  body?: string;
  destBrainId?: string;
  destFolderId?: string | null;
  expectedProposalRevision: number;
  expectedSourceBrainId: string;
}): Promise<ApproveResult> {
  if (!isUuid(opts.proposalId)) return { ok: false, reason: "Proposal not found." };
  if (!Number.isInteger(opts.expectedProposalRevision) || opts.expectedProposalRevision < 1) {
    return { ok: false, reason: "Stale view: reload the queue and resubmit the shown versions." };
  }
  if (!isUuid(opts.expectedSourceBrainId)) {
    return { ok: false, reason: "Stale view: reload the queue and resubmit the shown versions." };
  }
  const destBrainId = opts.destBrainId ?? null;
  if (destBrainId && !isUuid(destBrainId)) return { ok: false, reason: "Base not found." };
  if (opts.destFolderId && !isUuid(opts.destFolderId)) return { ok: false, reason: "Folder is in another base." };

  let woke = false;
  const out: ApproveResult = await tx(async (client): Promise<ApproveResult> => {
    const cur = await client.query<Note>(
      `select * from notes where id = $1 and status = 'pending' for update`,
      [opts.proposalId],
    );
    if (!cur.rowCount) return { ok: false, reason: "Proposal is no longer pending." };
    const proposal = cur.rows[0];
    if (proposal.revision !== opts.expectedProposalRevision) {
      return {
        ok: false,
        reason:
          "This proposal changed after you opened it (edited or moved by another reviewer). " +
          "Reload the queue — approval was refused so unseen content cannot ship.",
      };
    }
    if (proposal.brain_id !== opts.expectedSourceBrainId) {
      return {
        ok: false,
        reason: "This proposal moved to another base after you opened it. Reload the queue.",
      };
    }
    const sourceBrainId = proposal.brain_id;
    const finalBrainId = destBrainId ?? sourceBrainId;
    // Browser form submit normalizes LF to CRLF: an approval without saving
    // (or a title-only edit) carries the normalized bytes in hidden inputs, so
    // keep the stored proposal bytes when the diff is normalization-only.
    // Genuine content changes still use the submitted text. This covers
    // same-base acceptance and cross-base acceptance/copy alike.
    const wantedTitle = opts.title ?? proposal.title;
    const wantedBody = opts.body ?? proposal.body;
    const finalTitle =
      opts.title === undefined || normForCompare(wantedTitle) === normForCompare(proposal.title)
        ? proposal.title
        : wantedTitle;
    const finalBody = opts.body === undefined ? proposal.body : preservedBody(proposal.body, wantedBody);
    // Cross-base default: destination root. Never carry a source folder_id into
    // another base (the UI omits the selector for other bases, and a stale
    // source folder would fail scope validation with no way to pick root).
    let finalFolderId: string | null;
    if (finalBrainId !== sourceBrainId) {
      finalFolderId = opts.destFolderId !== undefined ? opts.destFolderId : null;
    } else {
      finalFolderId = proposal.folder_id;
      if (opts.destFolderId !== undefined) finalFolderId = opts.destFolderId;
    }

    if (finalFolderId) {
      const folder = await client.query(
        `select id from folders where id = $1 and brain_id = $2 for update`,
        [finalFolderId, finalBrainId],
      );
      if (!folder.rowCount) return { ok: false, reason: "Folder is in another base." };
    }

    const destBase = await client.query(`select id from brains where id = $1 for update`, [finalBrainId]);
    if (!destBase.rowCount) return { ok: false, reason: "Base not found." };

    if (!proposal.target_note_id) {
      const flipped = await client.query(
        `update notes set brain_id = $2, folder_id = $3, title = $4, body = $5, status = 'active'
          where id = $1 and status = 'pending'`,
        [proposal.id, finalBrainId, finalFolderId, finalTitle, finalBody],
      );
      if (!flipped.rowCount) return { ok: false, reason: "Proposal is no longer pending." };
      // Stage 5 sections (same tx as activation; outbox only when auto-index).
      const sync = await syncSvodSections(client, {
        brainId: finalBrainId,
        noteId: proposal.id,
        title: finalTitle,
        body: finalBody,
      });
      if (sync.queued) woke = true;
      await client.query(`update brains set content_changed_at = now() where id = $1`, [finalBrainId]);
      if (finalBrainId !== sourceBrainId) {
        await client.query(`update brains set content_changed_at = now() where id = $1`, [sourceBrainId]);
      }
      return { ok: true, kind: "new", noteId: proposal.id };
    }

    const targetId = proposal.target_note_id;
    // Scope every target read to the proposal base (never expose a target that
    // moved out of scope through the review UI).
    const target = await client.query<{ id: string; title: string; body: string; revision: number }>(
      `select id, title, body, revision from notes
        where id = $1 and brain_id = $2 and status = 'active' for update`,
      [targetId, sourceBrainId],
    );
    if (!target.rowCount) {
      // Target gone or moved out of this base: keep pending, do not leak the
      // new location. Reviewer sees that it is no longer reviewable here.
      return { ok: false, reason: "The original note is no longer available in this base." };
    }
    if (proposal.target_revision !== null && target.rows[0].revision !== proposal.target_revision) {
      return {
        ok: false,
        reason:
          "The original note changed after this proposal was written. " +
          "Review the current version and rebase this proposal before approving.",
        current: { title: target.rows[0].title, body: target.rows[0].body, revision: target.rows[0].revision },
      };
    }

    if (finalBrainId !== sourceBrainId) {
      // Safe destination move: NEVER mutate the original target. Create a NEW
      // active note in the destination base with the submitted final title
      // unchanged; transfer attribution lives on the superseded proposal row
      // (superseded_by + reason) and in the UI, not in the stored title.
      const moved = await client.query<Note>(
        `insert into notes (brain_id, folder_id, title, body, author, agent_client, status, proposed_by, token_id)
         values ($1, $2, $3, $4, 'agent', 'mcp', 'active', $5, $6)
         returning *`,
        [finalBrainId, finalFolderId, finalTitle, finalBody, proposal.proposed_by, proposal.token_id],
      );
      const newNote = moved.rows[0];
      const syncMoved = await syncSvodSections(client, {
        brainId: finalBrainId,
        noteId: newNote.id,
        title: finalTitle,
        body: finalBody,
      });
      if (syncMoved.queued) woke = true;
      await client.query(
        `update notes set status = 'superseded', superseded_by = $2,
           superseded_reason = $3 where id = $1 and status = 'pending'`,
        [proposal.id, newNote.id, `moved edit to base ${finalBrainId} from target ${targetId}`],
      );
      await client.query(`update brains set content_changed_at = now() where id = $1`, [finalBrainId]);
      await client.query(`update brains set content_changed_at = now() where id = $1`, [sourceBrainId]);
      return { ok: true, kind: "moved-edit", noteId: newNote.id };
    }

    await client.query(
      `update notes set folder_id = $3, title = $4, body = $5, updated_token_id = $6
        where id = $1 and brain_id = $2`,
      [targetId, sourceBrainId, finalFolderId, finalTitle, finalBody, proposal.token_id],
    );
    // Stage 5: reconcile sections (unchanged hashes keep id + vector).
    const syncEdit = await syncSvodSections(client, {
      brainId: sourceBrainId,
      noteId: targetId,
      title: finalTitle,
      body: finalBody,
    });
    if (syncEdit.queued) woke = true;
    await client.query(
      `update notes set status = 'superseded', superseded_by = $2 where id = $1 and status = 'pending'`,
      [proposal.id, targetId],
    );
    await client.query(`update brains set content_changed_at = now() where id = $1`, [sourceBrainId]);
    return { ok: true, kind: "edit", noteId: targetId };
  });
  if (woke) await wakeSvodIndexer().catch(() => {});
  return out;
}

export async function rejectProposal(proposalId: string): Promise<boolean> {
  if (!isUuid(proposalId)) return false;
  const { tx } = await import("@/db");
  return tx(async (client) => {
    const res = await client.query(
      `update notes set status = 'rejected' where id = $1 and status = 'pending'`,
      [proposalId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}
