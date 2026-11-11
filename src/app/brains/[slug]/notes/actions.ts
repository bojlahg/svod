"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query, maybeOne } from "@/db";
import { currentUser } from "@/lib/session";
import { normalizeCategory } from "@/lib/category";
import { brainAccessById } from "@/lib/svod-access";

/**
 * SVOD note mutations: editors and above only. Every action re-resolves the
 * note's base through the shared policy — a forged form with a known note ID
 * from another base is denied here, not just hidden in the UI.
 */
async function editableNote(noteId: string, userId: string) {
  const note = await maybeOne<{ id: string; brain_id: string }>(
    `select id, brain_id from notes where id = $1`,
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

  const note = await editableNote(String(formData.get("id")), user.id);
  if (!note) return;

  await query(`delete from notes where id = $1`, [note.id]);

  revalidatePath(`/brains/${String(formData.get("slug"))}/notes`);
}

export async function mergeNotes(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const keepId = String(formData.get("keep"));
  const dropId = String(formData.get("drop"));
  if (keepId === dropId) return;

  const keep = await editableNote(keepId, user.id);
  const drop = await editableNote(dropId, user.id);
  if (!keep || !drop || keep.brain_id !== drop.brain_id) return;

  await query(
    `update notes
        set status = 'superseded', superseded_by = $2,
            superseded_reason = 'merged into a note saying the same thing',
            superseded_at = now()
      where id = $1 and status = 'active'`,
    [drop.id, keep.id],
  );
  await query(`delete from chunks where note_id = $1`, [drop.id]);

  const access = await brainAccessById(keep.brain_id, user.id);
  void access;
  revalidatePath(`/brains/${String(formData.get("slug") ?? keep.brain_id)}/notes`);
}

export async function recategorise(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const note = await editableNote(String(formData.get("id")), user.id);
  if (!note) return;

  const raw = String(formData.get("category") ?? "").slice(0, 120);
  await query(`update notes set category = $2 where id = $1`, [
    note.id,
    normalizeCategory(raw),
  ]);

  revalidatePath(`/brains/${String(formData.get("slug") ?? note.brain_id)}/notes`);
}

export async function restoreNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const note = await editableNote(String(formData.get("id")), user.id);
  if (!note) return;

  await query(
    `update notes
        set status = 'pending', superseded_by = null,
            superseded_reason = null, superseded_at = null
      where id = $1 and status = 'superseded'`,
    [note.id],
  );

  revalidatePath(`/brains/${String(formData.get("slug") ?? note.brain_id)}/notes`);
}
