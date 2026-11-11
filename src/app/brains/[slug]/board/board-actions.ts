"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { one } from "@/db";
import type { Note } from "@/db/types";
import { currentUser } from "@/lib/session";
import { scanSecrets } from "@/lib/scan";
import { normalizeCategory } from "@/lib/category";
import { approve } from "@/lib/review";
import { workspaceBrain } from "@/lib/svod-access";

/**
 * Writing a note from the board. Editors and above only — readers cannot
 * mutate. The note routes through the one indexing path review owns.
 */
export async function addBoardNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  // SVOD: forged slug/ID hits the same policy as the page.
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canEdit) return;
  const brain = access.brain;

  const title = String(formData.get("title") ?? "").trim().slice(0, 200);
  const body = String(formData.get("body") ?? "").trim().slice(0, 20000);
  if (!title || !body) return;

  if (scanSecrets(`${title}\n${body}`).length) return;

  const note = await one<Note>(
    `insert into notes (brain_id, title, body, category, kind, author, status)
     values ($1, $2, $3, $4, 'fact', 'human', 'pending')
     returning *`,
    [
      brain.id,
      title,
      body,
      normalizeCategory(String(formData.get("category") ?? "") || null),
    ],
  );
  await approve(note);

  revalidatePath(`/brains/${slug}/board`);
}
