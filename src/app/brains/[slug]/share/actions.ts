"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query } from "@/db";
import { currentUser } from "@/lib/session";
import { workspaceBrain } from "@/lib/svod-access";

/**
 * SVOD stage 2 base member administration.
 *
 * Legacy sharing (email grants, gift links, visibility, purchases) is retired.
 * Role grants live in /admin/users (operator). Owners/operators may remove a
 * member here; forged IDs resolve their own base and are denied.
 */
export async function removeMember(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug") ?? "");
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canAdmin) return { error: "Base not found." };
  const userId = String(formData.get("userId") ?? "");
  const brainId = String(formData.get("brainId") ?? "");
  if (!userId || brainId !== access.brain.id) return { error: "Base not found." };

  await query(`delete from brain_members where brain_id = $1 and user_id = $2`, [
    access.brain.id,
    userId,
  ]);
  revalidatePath(`/brains/${slug}/share`);
  return { ok: true as const };
}

export async function noopShareAction() {
  return { error: "Retired: manage access in People (operator)." };
}
