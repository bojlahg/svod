"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query } from "@/db";
import { currentUser } from "@/lib/session";
import { enqueueExam } from "@/worker/queue";
import { setGoal } from "@/lib/goal";
import { parseTools } from "@/lib/brain-tools";
import { rateLimited } from "@/lib/rate-limit";
import { workspaceBrain } from "@/lib/svod-access";

/**
 * SVOD exam/goal/tool administration.
 * Goal + tools: editors and above (content configuration).
 * Checks + exam runs: owner/operator only (administration, spends budget).
 * Forged slugs/IDs resolve through the same policy as the page.
 */
async function editableBrain(slug: string, userId: string) {
  const access = await workspaceBrain(slug, userId);
  if (!access?.canEdit) return null;
  return access.brain;
}

async function adminBrain(slug: string, userId: string) {
  const access = await workspaceBrain(slug, userId);
  if (!access?.canAdmin) return null;
  return access.brain;
}

export async function saveGoal(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await editableBrain(slug, user.id);
  if (!brain) return { error: "Brain not found." };

  const goal = String(formData.get("goal") ?? "").trim().slice(0, 4000);
  const { changed } = await setGoal(brain.id, goal);

  revalidatePath(`/brains/${slug}`);
  return { ok: true as const, requeued: changed && Boolean(goal) };
}

export async function saveTools(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await editableBrain(slug, user.id);
  if (!brain) return { error: "Brain not found." };

  const tools = parseTools(
    String(formData.get("tools") ?? "")
      .split("\n")
      .map((line) => line.split("|").map((f) => f.trim()))
      .filter((f) => f[0])
      .map(([name, what, needs, install]) => ({ name, what, needs, install })),
  );

  await query(`update brains set tools = $2 where id = $1`, [
    brain.id,
    tools.length ? JSON.stringify(tools) : null,
  ]);

  revalidatePath(`/brains/${slug}`);
  return { ok: true as const, count: tools.length };
}

export async function addCheck(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;

  const question = String(formData.get("question") ?? "").trim().slice(0, 500);
  const expect = String(formData.get("expect") ?? "").trim().slice(0, 500);
  if (!question || !expect) return;

  const weight = Math.min(5, Math.max(1, Number(formData.get("weight") ?? 3) || 3));

  await query(
    `insert into checks (brain_id, category, question, expect, weight, origin)
     values ($1, 'Owner checks', $2, $3, $4, 'manual')`,
    [brain.id, question, expect, weight],
  );

  revalidatePath(`/brains/${slug}`);
}

export async function removeCheck(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;

  await query(
    `delete from checks where id = $1 and brain_id = $2 and origin = 'manual'`,
    [String(formData.get("id")), brain.id],
  );
  revalidatePath(`/brains/${slug}`);
}

export async function dismissGapSuggestion(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;

  await query(
    `update gap_suggestions set status = 'dismissed', resolved_at = now()
      where id = $1 and brain_id = $2 and status = 'pending'`,
    [String(formData.get("id")), brain.id],
  );
  revalidatePath(`/brains/${slug}`);
}

export async function runExamNow(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain?.goal) return;

  if (await rateLimited(user.id, "exam", 5)) return;

  if (formData.get("regenerate") === "1") {
    await query(`delete from checks where brain_id = $1 and origin = 'generated'`, [
      brain.id,
    ]);
  }

  await enqueueExam(brain.id, { force: true });
  revalidatePath(`/brains/${slug}`);
}
