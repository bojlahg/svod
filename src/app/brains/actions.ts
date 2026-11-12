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
import { brainAccessById } from "@/lib/svod-access";

const createSchema = z.object({
  title: z.string().trim().min(1, "Give the base a name").max(80),
  goal: z.string().trim().max(4000).optional(),
  docs: z.string().trim().max(2000).optional(),
  topic: z.string().catch("other").transform((t) => (TOPIC_KEYS.includes(t) ? t : "other")),
  parent: z.string().trim().optional(),
});

export async function createBrain(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = createSchema.safeParse({
    title: formData.get("title"),
    goal: formData.get("goal") || undefined,
    docs: undefined,
    topic: formData.get("topic") ?? "other",
    parent: String(formData.get("parent") ?? "") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  // SVOD stage 3: Markdown-only. No docs URL/crawl here — that was a paid
  // extraction path. Bases start empty; notes arrive via editor or .md upload.
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
     values ($1, $2, $3, $4, $5, $6, 'private', 0, 'knowledge') returning *`,
    [
      user.id,
      slug,
      parsed.data.title,
      parsed.data.goal ?? null,
      parsed.data.topic,
      parentId,
    ],
  );

  const { count } = await one<{ count: number }>(
    `select count(*)::int as count from brains where owner_id = $1`,
    [user.id],
  );
  if (count === 1) {
    captureServer(user.id, "first_brain_created", { brain_id: brain.id, via: "web" });
  }

  revalidatePath("/brains");
  redirect(`/brains/${brain.id}`);
}

export async function quickStart(_prev: unknown, _formData: FormData) {
  void _prev;
  void _formData;
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  // Stage 3 retired: URL → base + crawl was a paid extraction path.
  return { error: "Retired: create a base, then add Markdown notes." };
}

export async function updateGoal(brainId: string, _goal: string) {
  void _goal;
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // Stage 3 retired from the workspace with goals/exams. Role still proven.
  // Editor and above may edit; readers cannot. Forged forms hit the same check.
  const access = await brainAccessById(brainId, user.id);
  if (!access?.canEdit) return;
  return;
}
