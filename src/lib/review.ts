import { maybeOne, pool } from "@/db";
import type { Note } from "@/db/types";

/**
 * Turning a pending proposal into searchable content.
 *
 * SVOD stage 4: delegates to svod-proposals (trusted distinct path from
 * project direct-writes). Version guards are REQUIRED (no unversioned branch):
 * callers pass the proposal revision + source brain actually shown.
 *
 * `approve` below is the trusted non-"use server" CLI/service wrapper (scripts
 * review/judge-proposals): it reads the fresh proposal row and guards on that
 * revision, so scripts cannot approve unseen content either. All rendered web
 * forms submit shown versions through approveWithOptions.
 */

export async function approve(note: Note): Promise<boolean> {
  const { approveProposal } = await import("@/lib/svod-proposals");
  const fresh = await maybeOne<Pick<Note, "revision" | "brain_id">>(
    `select revision, brain_id from notes where id = $1 and status = 'pending'`,
    [note.id],
  );
  if (!fresh) return false;
  const res = await approveProposal({
    proposalId: note.id,
    expectedProposalRevision: fresh.revision,
    expectedSourceBrainId: fresh.brain_id,
  });
  return res.ok;
}

export async function approveWithOptions(opts: {
  proposalId: string;
  title?: string;
  body?: string;
  destBrainId?: string;
  destFolderId?: string | null;
  expectedProposalRevision: number;
  expectedSourceBrainId: string;
}): Promise<{ ok: boolean; reason?: string; kind?: "new" | "edit" | "moved-edit"; noteId?: string; current?: { title: string; body: string; revision: number } }> {
  const { approveProposal } = await import("@/lib/svod-proposals");
  const res = await approveProposal(opts);
  if (res.ok) return { ok: true, kind: res.kind, noteId: res.noteId };
  return { ok: false, reason: res.reason, current: (res as { current?: { title: string; body: string; revision: number } }).current };
}

export async function reject(noteId: string): Promise<boolean> {
  const res = await pool.query(
    `update notes set status = 'rejected' where id = $1 and status = 'pending'`,
    [noteId],
  );
  return (res.rowCount ?? 0) > 0;
}
