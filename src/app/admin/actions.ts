"use server";

import { revalidatePath } from "next/cache";
import { query } from "@/db";
import { requireAdmin } from "@/lib/admin";

/**
 * Operator actions. SVOD stage 7: only error triage remains.
 * Every entry point re-checks requireAdmin().
 */

/**
 * Close a whole family of errors at once — triage works in kinds, not rows.
 * Resolving is acknowledgement, not deletion: the rows stay for postmortems.
 */
export async function resolveErrors(formData: FormData) {
  const admin = await requireAdmin();
  const source = String(formData.get("source") ?? "");
  const kind = String(formData.get("kind") ?? "");

  if (source === "*") {
    await query(`update app_errors set resolved_at = now() where resolved_at is null`);
  } else if (source && kind) {
    await query(
      `update app_errors set resolved_at = now()
        where source = $1 and kind = $2 and resolved_at is null`,
      [source, kind],
    );
  }
  console.log(`[admin] ${admin.email} resolved errors ${source}/${kind}`);
  revalidatePath("/admin/errors");
}
