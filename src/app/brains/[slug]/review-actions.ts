"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { maybeOne, query } from "@/db";
import type { Note } from "@/db/types";
import { refreshNoteWeight } from "@/lib/note-weight";
import { approveWithOptions, reject } from "@/lib/review";
import { currentUser } from "@/lib/session";
import { brainAccessById } from "@/lib/svod-access";
import { isUuid } from "@/lib/svod-folders";
import { validateNoteBody, validateNoteTitle } from "@/lib/svod-notes";

/**
 * SVOD stage 4 review queue: reviewers and above only. Readers must neither see
 * pending rows (gated in the page) nor approve/reject/edit them — a forged form
 * with a known note ID hits the same checks here.
 *
 * Version-guarded: the UI submits the proposal revision + source brain actually
 * shown; approval refuses when either moved (no unseen content ships). Edit
 * (rebase) is guarded by expected proposal + target revisions and refreshes the
 * proposal onto the current accepted revision. Conflicts remain pending with
 * readable feedback + current version for display (returned, not swallowed).
 */

async function reviewableNote(noteId: string, userId: string): Promise<Note | null> {
  if (!isUuid(noteId)) return null;
  const note = await maybeOne<Note>(
    `select n.* from notes n where n.id = $1 and n.status = 'pending'`,
    [noteId],
  );
  if (!note) return null;
  const access = await brainAccessById(note.brain_id, userId);
  if (!access?.canReview) return null;
  return note;
}

function parseRevision(raw: FormDataEntryValue | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(String(raw));
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Canonical revalidation for review mutations. The browser may sit on the
 * canonical UUID route (/brains/<uuid>) while the form posts the human slug
 * (or vice versa); other workspace actions invalidate both plus the index.
 * Revalidating only the posted slug leaves the visible route stale — the
 * queue and reader keep showing the pre-save revision.
 */
function revalidateProposalScope(brainId: string, slugParam: string) {
  revalidatePath(`/brains/${brainId}`);
  if (slugParam && slugParam !== brainId) revalidatePath(`/brains/${slugParam}`);
  revalidatePath("/brains");
}

export async function approveNote(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const note = await reviewableNote(String(formData.get("id")), user.id);
  if (!note) return { error: "Proposal not found." };

  const rawTitle = formData.get("title");
  const rawBody = formData.get("body");
  const destBrainRaw = String(formData.get("destBrainId") ?? "").trim();
  const destFolderRaw = String(formData.get("destFolderId") ?? "").trim();
  const destBrainId = destBrainRaw && destBrainRaw !== note.brain_id ? destBrainRaw : undefined;
  const destFolderId = !formData.has("destFolderId")
    ? undefined
    : destFolderRaw === "" || destFolderRaw === "__keep"
      ? undefined
      : destFolderRaw === "__root"
        ? null
        : destFolderRaw || null;

  // REQUIRED versions as shown in the UI (forged omission/malformed refused).
  const expectedProposalRevision = parseRevision(formData.get("expectedProposalRevision"));
  const expectedSourceBrainRaw = String(formData.get("expectedSourceBrainId") ?? "").trim();
  if (expectedProposalRevision === undefined || !isUuid(expectedSourceBrainRaw)) {
    return { error: "Stale view: reload the queue and resubmit the shown versions." };
  }
  const expectedSourceBrainId = expectedSourceBrainRaw;

  let title: string | undefined;
  let body: string | undefined;
  if (rawTitle !== null || rawBody !== null) {
    const tv = validateNoteTitle(rawTitle ?? note.title);
    const bv = validateNoteBody(rawBody ?? note.body);
    if (!tv.ok) return { error: tv.error };
    if (!bv.ok) return { error: bv.error };
    title = tv.title;
    body = bv.body;
  }

  if (destBrainId) {
    if (!isUuid(destBrainId)) return { error: "Base not found." };
    const destAccess = await brainAccessById(destBrainId, user.id);
    if (!destAccess?.canReview) return { error: "Base not found." };
    if (destFolderId) {
      if (!isUuid(destFolderId)) return { error: "Folder is in another base." };
      const f = await maybeOne<{ id: string }>(
        `select id from folders where id = $1 and brain_id = $2`,
        [destFolderId, destBrainId],
      );
      if (!f) return { error: "Folder is in another base." };
    }
  } else if (destFolderId) {
    if (!isUuid(destFolderId)) return { error: "Folder is in another base." };
    const f = await maybeOne<{ id: string }>(
      `select id from folders where id = $1 and brain_id = $2`,
      [destFolderId, note.brain_id],
    );
    if (!f) return { error: "Folder is in another base." };
  }

  const res = await approveWithOptions({
    proposalId: note.id,
    title,
    body,
    destBrainId,
    destFolderId,
    expectedProposalRevision,
    expectedSourceBrainId,
  });
  if (!res.ok) {
    return {
      error: res.reason,
      current: (res as { current?: { title: string; body: string; revision: number } }).current ?? null,
    };
  }
  // Success: leave the stale proposal URL and land on the actual accepted note
  // in its destination base (same-base edit → target ID in source; new-note →
  // proposal ID in dest; moved edit → new note ID in dest). Title/body, stable
  // ID and token attribution are unchanged by navigation. Conflicts/denials
  // return above with the proposal kept pending and feedback shown.
  const finalBrainId = destBrainId ?? note.brain_id;
  const acceptedId = res.noteId;
  revalidateProposalScope(note.brain_id, String(formData.get("slug")));
  if (destBrainId) revalidatePath(`/brains/${destBrainId}`);
  if (!isUuid(finalBrainId) || !isUuid(acceptedId)) return { error: "Approved." };
  redirect(`/brains/${finalBrainId}?note=${acceptedId}`);
}

export async function editProposalAction(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const note = await reviewableNote(String(formData.get("id")), user.id);
  if (!note) return { error: "Proposal not found." };
  const tv = validateNoteTitle(formData.get("title") ?? note.title);
  const bv = validateNoteBody(formData.get("body") ?? note.body);
  if (!tv.ok) return { error: tv.error };
  if (!bv.ok) return { error: bv.error };
  const expectedProposalRevision = parseRevision(formData.get("expectedProposalRevision"));
  const expectedTargetRaw = formData.get("expectedTargetRevision");
  if (expectedProposalRevision === undefined) {
    return { error: "Stale view: reload the queue and resubmit the shown versions." };
  }
  // New-note proposals submit empty target revision; edits must submit the
  // shown integer. Malformed values are forged omission → refuse.
  let expectedTargetRevision: number | null = null;
  if (note.target_note_id) {
    if (expectedTargetRaw === null || String(expectedTargetRaw) === "") {
      return { error: "Stale view: reload the queue and resubmit the shown versions." };
    }
    const parsed = parseRevision(expectedTargetRaw);
    if (parsed === undefined) {
      return { error: "Stale view: reload the queue and resubmit the shown versions." };
    }
    expectedTargetRevision = parsed;
  } else if (expectedTargetRaw !== null && String(expectedTargetRaw) !== "") {
    return { error: "Stale view: reload the queue and resubmit the shown versions." };
  }
  const { editProposal } = await import("@/lib/svod-proposals");
  const res = await editProposal({
    brainId: note.brain_id,
    proposalId: note.id,
    title: tv.title,
    body: bv.body,
    expectedProposalRevision,
    expectedTargetRevision,
  });
  revalidateProposalScope(note.brain_id, String(formData.get("slug")));
  if (!res.ok) {
    return {
      error: res.reason,
      current: (res as { current?: { title: string; body: string; revision: number } }).current ?? null,
    };
  }
  return { ok: true as const, revision: res.proposal.revision };
}

export async function dismissFlag(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const flag = await maybeOne<{ brain_id: string; note_id: string }>(
    `select brain_id, note_id from note_flags where id = $1`,
    [String(formData.get("id"))],
  );
  if (!flag) return;
  const access = await brainAccessById(flag.brain_id, user.id);
  if (!access?.canReview) return;

  const deleted = await query<{ note_id: string }>(
    `delete from note_flags where id = $1 returning note_id`,
    [String(formData.get("id"))],
  );
  if (deleted.length) await refreshNoteWeight(deleted[0].note_id);
  revalidateProposalScope(flag.brain_id, String(formData.get("slug")));
}

export async function rejectNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const note = await reviewableNote(String(formData.get("id")), user.id);
  if (!note) return;

  await reject(note.id);
  revalidateProposalScope(note.brain_id, String(formData.get("slug")));
}
