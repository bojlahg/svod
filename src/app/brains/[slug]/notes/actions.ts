"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query, maybeOne } from "@/db";
import { currentUser } from "@/lib/session";
import { brainAccessById } from "@/lib/svod-access";
import { isUuid } from "@/lib/svod-folders";

/**
 * SVOD stage 3: legacy note mutations retired except delete, now active-only.
 * merge/recategorise/restore served the exam/category pipeline — direct
 * invocation is denied after the same checks. deleteNote is scoped to active
 * notes in this base by ID at the SQL boundary (editors and above only), so a
 * replayed editor form can no longer delete a pending proposal. Legacy
 * proposals stay readable only by reviewers (see the workspace review queue).
 * Malformed UUIDs are rejected before SQL (no 22P02).
 */
async function editableNote(noteId: string, userId: string) {
  if (!isUuid(noteId)) return null;
  const note = await maybeOne<{ id: string; brain_id: string }>(
    `select id, brain_id from notes where id = $1 and status = 'active'`,
    [noteId],
  );
  if (!note) return null;
  const access = await brainAccessById(note.brain_id, userId);
  if (!access?.canEdit) return null;
  return note;
}

export async function deleteNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const rawId = String(formData.get("id"));
  if (!isUuid(rawId)) return;
  const note = await editableNote(rawId, user.id);
  if (!note) return;

  await query(`delete from notes where id = $1 and status = 'active'`, [note.id]);

  revalidatePath(`/brains/${String(formData.get("slug"))}/notes`);
}

export async function mergeNotes(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired with the duplicate/exam pipeline. Role still proven first.
  const keepId = String(formData.get("keep"));
  const dropId = String(formData.get("drop"));
  if (!isUuid(keepId) || !isUuid(dropId)) return;
  if (keepId === dropId) return;
  const keep = await editableNote(keepId, user.id);
  const drop = await editableNote(dropId, user.id);
  if (!keep || !drop || keep.brain_id !== drop.brain_id) return;
  return;
}

export async function recategorise(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired with categories/exam. Folders replace categories.
  const rawId = String(formData.get("id"));
  if (!isUuid(rawId)) return;
  const note = await editableNote(rawId, user.id);
  if (!note) return;
  return;
}

export async function restoreNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired with superseded/exam history.
  const rawId = String(formData.get("id"));
  if (!isUuid(rawId)) return;
  const note = await editableNote(rawId, user.id);
  if (!note) return;
  return;
}
