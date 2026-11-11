"use server";

import { revalidatePath } from "next/cache";
import { isCrawlRoot } from "@/lib/sources";
import { redirect } from "next/navigation";
import { maybeOne, one, query } from "@/db";
import type { Source } from "@/db/types";
import { currentUser } from "@/lib/session";
import { storage } from "@/lib/storage";
import { checkFetchableUrl } from "@/lib/url-guard";
import { rateLimited } from "@/lib/rate-limit";
import { workspaceBrain, brainAccessById } from "@/lib/svod-access";
import { enqueueIngest, enqueueCrawl } from "@/worker/queue";

/**
 * SVOD source mutations: editors and above only, enforced per action.
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

  const source = await editableSource(String(formData.get("id")), user.id);
  if (!source) return;

  if (await rateLimited(user.id, "ingest-retry", 10)) return;

  await query(`delete from notes where source_id = $1`, [source.id]);
  await query(
    `update sources set status = 'queued', error = null, reject_reason = null,
            findings = null, note_count = 0, processed_at = null
      where id = $1`,
    [source.id],
  );

  await (isCrawlRoot(source.kind) ? enqueueCrawl(source.id) : enqueueIngest(source.id));
  revalidatePath(`/brains/${String(formData.get("slug"))}`);
}

export async function addUrls(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  // SVOD: the identifier may be an ID (shared) or an owned slug.
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canEdit) return { error: "Brain not found." };
  const brain = access.brain;

  const lines = String(formData.get("urls") ?? "")
    .split(/[\n\s]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 25);

  if (!lines.length) return { error: "Paste at least one URL." };

  const suggestionId = String(formData.get("suggestion") ?? "");
  const acceptSuggestion = async () => {
    if (!suggestionId) return;
    await query(
      `update gap_suggestions set status = 'accepted', resolved_at = now()
        where id = $1 and brain_id = $2 and status = 'pending'`,
      [suggestionId, brain.id],
    );
  };

  if (formData.get("crawl") === "on") {
    if (lines.length > 1) {
      return { error: "Whole-site mode takes one URL — the root of the docs." };
    }
    const check = await checkFetchableUrl(lines[0]);
    if (!check.ok || !check.url) {
      return { error: `${lines[0].slice(0, 60)} — ${check.reason}.` };
    }
    const site = await one<Source>(
      `insert into sources (brain_id, kind, url, original_name)
       values ($1, 'site', $2, $3) returning *`,
      [brain.id, check.url, `${new URL(check.url).hostname} (whole site)`],
    );
    await enqueueCrawl(site.id);
    await acceptSuggestion();
    revalidatePath(`/brains/${slug}`);
    return { added: 1, refused: [], site: check.url };
  }

  const added: string[] = [];
  const refused: string[] = [];

  for (const line of lines) {
    const check = await checkFetchableUrl(line);
    if (!check.ok || !check.url) {
      refused.push(`${line.slice(0, 60)} — ${check.reason}`);
      continue;
    }

    const source = await one<Source>(
      `insert into sources (brain_id, kind, url, original_name)
       values ($1, 'url', $2, $3) returning *`,
      [brain.id, check.url, new URL(check.url).hostname],
    );
    await enqueueIngest(source.id);
    added.push(check.url);
  }

  if (added.length) await acceptSuggestion();
  revalidatePath(`/brains/${slug}`);
  return { added: added.length, refused };
}

export async function waiveScan(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const source = await editableSource(String(formData.get("id")), user.id);
  if (!source || source.status !== "rejected") return;

  await query(
    `update sources set scan_waived = true, status = 'queued', reject_reason = null
      where id = $1`,
    [source.id],
  );
  await enqueueIngest(source.id);
  revalidatePath(`/brains/${String(formData.get("slug"))}`);
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

  const slug = String(formData.get("slug"));
  const id = String(formData.get("id") ?? "");

  // Clearing takes no source: the empty id is the "remove it" case.
  if (!id) {
    const access = await workspaceBrain(slug, user.id);
    if (!access?.canEdit) return;
    await query(`update brains set cover_key = null where id = $1`, [access.brain.id]);
    revalidatePath(`/brains/${slug}`);
    return;
  }

  const source = await editableSource(id, user.id);
  if (!source || source.kind !== "image" || !source.storage_key) return;

  await query(`update brains set cover_key = $2 where id = $1`, [
    source.brain_id,
    source.storage_key,
  ]);
  revalidatePath(`/brains/${slug}`);
}
