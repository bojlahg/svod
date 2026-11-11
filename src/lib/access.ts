import type { Brain } from "@/db/types";
import { brainAccessById } from "@/lib/svod-access";

/**
 * SVOD stage 2 compatibility shim.
 *
 * Authority is brain_members + owner + env operator (lib/svod-access.ts,
 * migration 0093). Legacy doors — grants, public visibility, purchases, pack
 * access — grant nothing. New code should import lib/svod-access directly;
 * this keeps the old Access shape so retained callers enforce the same policy.
 */

export type Access = "owner" | "contributor" | "viewer" | null;

export interface Resolved {
  brain: Brain;
  access: Access;
  /** Legacy field: SVOD has no paid previews — always false. */
  preview: boolean;
}

export async function accessFor(
  brainId: string,
  userId: string | null,
): Promise<Resolved | null> {
  const found = await brainAccessById(brainId, userId);
  if (!found) return null;
  // The operator bypasses grants: without this the shim would read
  // "no grant" as "no access" for exactly the principal that administers
  // every base.
  const access = found.isOperator ? "owner" : toLegacy(found.role);
  if (!access) return { brain: found.brain, access: null, preview: false };
  return { brain: found.brain, access, preview: false };
}

export async function accessForSlug(
  handle: string,
  slug: string,
  userId: string | null,
): Promise<Resolved | null> {
  const { brainAccessByHandleSlug } = await import("@/lib/svod-access");
  const found = await brainAccessByHandleSlug(handle, slug, userId);
  if (!found) return null;
  const access = found.isOperator ? "owner" : toLegacy(found.role);
  if (!access) return { brain: found.brain, access: null, preview: false };
  return { brain: found.brain, access, preview: false };
}

function toLegacy(role: "owner" | "reader" | "editor" | "reviewer" | null): Access {
  if (role === "owner") return "owner";
  if (role === "editor" || role === "reviewer") return "contributor";
  if (role === "reader") return "viewer";
  return null;
}

export async function canRead(brainId: string, userId: string | null): Promise<boolean> {
  const result = await accessFor(brainId, userId);
  return Boolean(result?.access);
}

export function canWrite(access: Access): boolean {
  return access === "owner" || access === "contributor";
}

/**
 * Proposing is not writing. Anyone who may read a brain may offer it a note,
 * and that note waits pending until a reviewer approves it.
 */
export function canPropose(access: Access): boolean {
  return access !== null;
}

export function canAdmin(access: Access): boolean {
  return access === "owner";
}

/** SVOD stage 2: exports are gated by role only — no licence or plan gate. */
export function canExport(_brain: Brain, access: Access): boolean {
  return access !== null;
}
