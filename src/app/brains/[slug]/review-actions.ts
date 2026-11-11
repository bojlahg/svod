"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { maybeOne, query } from "@/db";
import type { Note } from "@/db/types";
import { refreshNoteWeight } from "@/lib/note-weight";
import { approve, reject } from "@/lib/review";
import { currentUser } from "@/lib/session";
import { brainAccessById } from "@/lib/svod-access";

/**
 * SVOD review queue: reviewers and above only. Readers must neither see
 * pending rows (gated in the page) nor approve/reject them — a forged form
 * with a known note ID hits the same check here.
 */

async function reviewableNote(noteId: string, userId: string): Promise<Note | null> {
  const note = await maybeOne<Note>(
    `select n.* from notes n where n.id = $1 and n.status = 'pending'`,
    [noteId],
  );
  if (!note) return null;
  const access = await brainAccessById(note.brain_id, userId);
  if (!access?.canReview) return null;
  return note;
}

export async function approveNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const note = await reviewableNote(String(formData.get("id")), user.id);
  if (!note) return;

  await approve(note);

  revalidatePath(`/brains/${String(formData.get("slug"))}`);
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
  revalidatePath(`/brains/${String(formData.get("slug"))}`);
}

export async function rejectNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const note = await reviewableNote(String(formData.get("id")), user.id);
  if (!note) return;

  // Atomic in lib/review: a concurrent approval/rejection wins exactly once;
  // the loser is a no-op that still revalidates to the current state.
  await reject(note.id);
  revalidatePath(`/brains/${String(formData.get("slug"))}`);
}
