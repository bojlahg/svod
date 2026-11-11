"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { maybeOne, query } from "@/db";
import type { Source } from "@/db/types";
import { currentUser } from "@/lib/session";
import { storage } from "@/lib/storage";
import { workspaceBrain, brainAccessById } from "@/lib/svod-access";

/**
 * SVOD stage 3: Markdown-only workspace.
 * Legacy extraction/URL/PDF paths are retired — direct invocation is denied
 * after the same role checks (unknown/ungranted are still 404, readers still
 * denied). deleteSource stays: removing an authorized attachment is a content
 * op editors may do; reading attachments stays via /api/storage.
 * A forged source ID from another base resolves its own brain and is denied.
 */
async function editableSource(sourceId: string, userId: string): Promise<Source | null> {
  const source = await maybeOne<Source>(`select * from sources where id = $1`, [sourceId]);
  if (!source) return null;
  const access = await brainAccessById(source.brain_id, userId);
  if (!access?.canEdit) return null;
  return source;
}

export async function retrySource(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired: re-ingest would re-run paid extraction. Role is still
  // proven first so a forged ID learns nothing new.
  const source = await editableSource(String(formData.get("id")), user.id);
  if (!source) return;
  return;
}

export async function addUrls(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired: URL/crawl ingest is a paid extraction path. The workspace
  // uses Markdown notes (.md upload or editor). Role still proven by IDs.
  const slug = String(formData.get("slug"));
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canEdit) return { error: "Brain not found." };
  return { error: "Retired: add a Markdown note instead (.md upload or editor)." };
}

export async function waiveScan(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired with the extraction pipeline it served.
  const source = await editableSource(String(formData.get("id")), user.id);
  if (!source) return;
  return;
}

export async function deleteSource(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const source = await editableSource(String(formData.get("id")), user.id);
  if (!source) return;

  if (source.storage_key) {
    await storage.del(source.storage_key).catch(() => {});
  }
  await query(`delete from sources where id = $1`, [source.id]);

  revalidatePath(`/brains/${String(formData.get("slug"))}`);
}

export async function setCover(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired with the catalogue/gallery it served.
  const slug = String(formData.get("slug"));
  const id = String(formData.get("id") ?? "");
  if (!id) {
    const access = await workspaceBrain(slug, user.id);
    if (!access?.canEdit) return;
    return;
  }

  const source = await editableSource(id, user.id);
  if (!source) return;
  return;
}
