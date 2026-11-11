"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { query, maybeOne } from "@/db";
import { currentUser } from "@/lib/session";
import { workspaceBrain } from "@/lib/svod-access";
import { storage } from "@/lib/storage";

/**
 * SVOD: owner/operator only. The purchase refusal stays — deleting a base
 * others were sold is taking back what they paid for.
 */
export async function deleteBrain(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canAdmin) return { error: "Base not found." };
  const brain = access.brain;

  if (String(formData.get("confirm")).trim() !== brain.title) {
    return { error: `Type "${brain.title}" exactly to confirm.` };
  }

  const sold = await maybeOne<{ n: number }>(
    `select count(*)::int as n from purchases where brain_id = $1`,
    [brain.id],
  );
  if (sold && sold.n > 0) {
    return {
      error:
        `This base has been bought ${sold.n} time${sold.n === 1 ? "" : "s"}, so it cannot ` +
        "be deleted — that would take back something people paid for.",
    };
  }

  const keys = await query<{ storage_key: string }>(
    `select storage_key from sources
      where brain_id = $1 and storage_key is not null`,
    [brain.id],
  );

  await query(`delete from brains where id = $1`, [brain.id]);
  await Promise.all(keys.map((k) => storage.del(k.storage_key).catch(() => {})));

  revalidatePath("/brains");
  redirect("/brains");
}
