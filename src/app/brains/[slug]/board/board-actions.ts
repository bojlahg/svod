"use server";

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { workspaceBrain } from "@/lib/svod-access";

/**
 * SVOD stage 3: retired. The board wrote notes through the old indexing path;
 * the Markdown workspace (svod-actions) is the only write door now. The role
 * check stays so a forged form learns nothing new — then nothing is written.
 */
export async function addBoardNote(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  // SVOD: forged slug/ID hits the same policy as the page — then retired.
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canEdit) return;
  return;
}
