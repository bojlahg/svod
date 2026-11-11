"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { query } from "@/db";
import { currentUser } from "@/lib/session";

/** Handles are a local namespace, so they are strict. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const RESERVED = new Set([
  "admin", "api", "b", "beta", "brains", "changelog", "chat", "connect",
  "earn", "explore", "gift", "guide", "make", "mcp", "mind", "pay", "pricing", "r",
  "settings", "sign-in", "sign-up", "vs", "vs-skills", "why", "www",
  "support", "help",
]);

export async function updateProfile(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = z
    .object({
      name: z.string().trim().min(1, "A name cannot be empty").max(60),
      handle: z
        .string()
        .trim()
        .toLowerCase()
        .regex(HANDLE, "Handles are 3–30 characters: letters, numbers and dashes"),
    })
    .safeParse({ name: formData.get("name"), handle: formData.get("handle") });

  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (RESERVED.has(parsed.data.handle)) {
    return { error: "That handle is reserved." };
  }

  const taken = await query(
    `select 1 from "user" where handle = $1 and id <> $2`,
    [parsed.data.handle, user.id],
  );
  if (taken.length) return { error: "That handle is taken." };

  try {
    await query(
      `update "user" set name = $2, handle = $3, "updatedAt" = now() where id = $1`,
      [user.id, parsed.data.name, parsed.data.handle],
    );
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return { error: "That handle is taken." };
    }
    throw err;
  }

  revalidatePath("/settings");
  return { ok: true as const, handle: parsed.data.handle };
}
