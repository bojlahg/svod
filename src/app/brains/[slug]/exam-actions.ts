"use server";

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { workspaceBrain } from "@/lib/svod-access";

/**
 * SVOD stage 3: exam/goal/tool administration retired from the workspace.
 * No paid LLM is scheduled from any exposed path. Role checks stay (forged
 * slugs/IDs still resolve through the same policy), then direct invocation is
 * denied without side effects.
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
  return { error: "Retired: goals/exams are not part of the Markdown workspace." };
}

export async function saveTools(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await editableBrain(slug, user.id);
  if (!brain) return { error: "Brain not found." };
  return { error: "Retired: tools are not part of the Markdown workspace." };
}

export async function addCheck(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;
  return;
}

export async function removeCheck(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;
  return;
}

export async function dismissGapSuggestion(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;
  return;
}

export async function runExamNow(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // No paid LLM scheduling from any exposed path (stage 3).
  const slug = String(formData.get("slug"));
  const brain = await adminBrain(slug, user.id);
  if (!brain) return;
  return;
}
