"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { one, maybeOne, exists } from "@/db";
import type { Brain } from "@/db/types";
import { currentUser } from "@/lib/session";
import { slugify } from "@/lib/brains";
import { captureServer } from "@/lib/analytics";
import { TOPIC_KEYS } from "@/lib/topics";
import { checkFetchableUrl } from "@/lib/url-guard";
import { brainAccessById } from "@/lib/svod-access";
import { enqueueCrawl } from "@/worker/queue";

const createSchema = z.object({
  title: z.string().trim().min(1, "Give the base a name").max(80),
  goal: z.string().trim().max(4000).optional(),
  docs: z.string().trim().max(2000).optional(),
  topic: z.string().catch("other").transform((t) => (TOPIC_KEYS.includes(t) ? t : "other")),
  parent: z.string().trim().optional(),
  kind: z.enum(["knowledge", "style"]).catch("knowledge"),
});

export async function createBrain(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = createSchema.safeParse({
    title: formData.get("title"),
    goal: formData.get("goal") || undefined,
    docs: String(formData.get("docs") ?? "") || undefined,
    topic: formData.get("topic") ?? "other",
    kind: formData.get("kind") === "style" ? "style" : "knowledge",
    parent: String(formData.get("parent") ?? "") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  let docsUrl: string | null = null;
  if (parsed.data.docs) {
    const check = await checkFetchableUrl(parsed.data.docs);
    if (!check.ok || !check.url) {
      return { error: `That docs link was refused — ${check.reason}.` };
    }
    docsUrl = check.url;
  }

  // SVOD: no plan caps on creating bases. Every signed-in user may create;
  // new bases are always private.
  const base = slugify(parsed.data.title);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const taken = await exists(
      `select 1 from brains where owner_id = $1 and slug = $2`,
      [user.id, slug],
    );
    if (!taken) break;
    slug = `${base}-${i}`.slice(0, 39);
  }

  let parentId: string | null = null;
  if (parsed.data.parent) {
    const parent = await maybeOne<{ id: string; parent_id: string | null }>(
      `select id, parent_id from brains where owner_id = $1 and id = $2`,
      [user.id, parsed.data.parent],
    );
    if (!parent) return { error: "That parent base does not exist." };
    if (parent.parent_id) {
      return { error: "Bases group one level deep. Pick a top-level base." };
    }
    parentId = parent.id;
  }

  const brain = await one<Brain>(
    `insert into brains (owner_id, slug, title, goal, topic, parent_id, visibility, price_cents, kind)
     values ($1, $2, $3, $4, $5, $6, 'private', 0, $7) returning *`,
    [
      user.id,
      slug,
      parsed.data.title,
      parsed.data.goal ?? null,
      parsed.data.topic,
      parentId,
      parsed.data.kind,
    ],
  );

  const { count } = await one<{ count: number }>(
    `select count(*)::int as count from brains where owner_id = $1`,
    [user.id],
  );
  if (count === 1) {
    captureServer(user.id, "first_brain_created", { brain_id: brain.id, via: "web" });
  }

  if (docsUrl) {
    const site = await one<{ id: string }>(
      `insert into sources (brain_id, kind, url, original_name)
       values ($1, 'site', $2, $3) returning id`,
      [brain.id, docsUrl, `${new URL(docsUrl).hostname} (whole site)`],
    );
    await enqueueCrawl(site.id);
  }

  revalidatePath("/brains");
  redirect(`/brains/${brain.id}`);
}

export async function quickStart(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const raw = String(formData.get("url") ?? "").trim();
  if (!raw) return { error: "Paste a link to the documentation." };

  const check = await checkFetchableUrl(raw.includes("://") ? raw : `https://${raw}`);
  if (!check.ok || !check.url) {
    return { error: `That link was refused — ${check.reason}.` };
  }

  const url = new URL(check.url);
  const title =
    url.hostname === "github.com"
      ? url.pathname.split("/").filter(Boolean).slice(0, 2).join("/") || url.hostname
      : url.hostname.replace(/^www\./, "");

  const base = slugify(title);
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const taken = await exists(
      `select 1 from brains where owner_id = $1 and slug = $2`,
      [user.id, slug],
    );
    if (!taken) break;
    slug = `${base}-${i}`.slice(0, 39);
  }

  const brain = await one<Brain>(
    `insert into brains (owner_id, slug, title, topic, visibility, price_cents) values ($1, $2, $3, 'other', 'private', 0)
     returning *`,
    [user.id, slug, title.slice(0, 80)],
  );
  const { count } = await one<{ count: number }>(
    `select count(*)::int as count from brains where owner_id = $1`,
    [user.id],
  );
  if (count === 1) {
    captureServer(user.id, "first_brain_created", { brain_id: brain.id, via: "quickstart" });
  }
  const site = await one<{ id: string }>(
    `insert into sources (brain_id, kind, url, original_name)
     values ($1, 'site', $2, $3) returning id`,
    [brain.id, check.url, `${url.hostname} (whole site)`],
  );
  await enqueueCrawl(site.id);

  revalidatePath("/brains");
  redirect(`/brains/${brain.id}`);
}

export async function updateGoal(brainId: string, goal: string) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Editor and above may edit; readers cannot. Forged forms hit the same check.
  const access = await brainAccessById(brainId, user.id);
  if (!access?.canEdit) return;

  const { query } = await import("@/db");
  await query(`update brains set goal = $2 where id = $1`, [brainId, goal.trim() || null]);
  revalidatePath("/brains");
}
