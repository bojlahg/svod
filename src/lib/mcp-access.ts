import { maybeOne } from "@/db";
import type { Brain } from "@/db/types";
import type { Access } from "@/lib/access";
import { brainAccessById } from "@/lib/svod-access";

export const TEASER_CALLS = 5;

export interface Resolved {
  brain: Brain;
  access: Access;
  /** SVOD has no paid previews — never set. Kept for caller compatibility. */
  teaser?: { used: number; limit: number };
  locked?: boolean;
}

/**
 * SVOD stage 2 MCP resolution.
 *
 * Same authority as the web: owner, brain_members, env operator. No public
 * catalogue, no teaser, no paywall, no packs — a migrated public row exposes
 * nothing without an explicit grant. Accepts a UUID or "handle/slug" or (for
 * the caller's own bases) a bare slug; bare slugs never resolve across owners.
 */

async function inHeldPack(): Promise<boolean> {
  return false;
}

void inHeldPack;

export async function resolveBrain(
  handle: string,
  userId: string,
): Promise<Resolved | null> {
  const trimmed = handle.trim();
  if (!trimmed) return null;

  if (trimmed.includes("/")) {
    const [maybeOwner, maybeSlug] = trimmed.split("/", 2);
    const { brainAccessByHandleSlug } = await import("@/lib/svod-access");
    const found = await brainAccessByHandleSlug(maybeOwner, maybeSlug, userId);
    if (!found || !found.canRead) return null;
    return { brain: found.brain, access: found.isOperator ? "owner" : toLegacy(found.role) };
  }

  // UUID: the stable shared identifier — direct lookup with a policy check.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    const found = await brainAccessById(trimmed, userId);
    if (!found || !found.canRead) return null;
    return { brain: found.brain, access: found.isOperator ? "owner" : toLegacy(found.role) };
  }

  // Bare slug: only the caller's own bases, exactly as before — never a guess
  // across owners.
  const brain = await maybeOne<Brain>(
    `select * from brains where owner_id = $1 and slug = $2`,
    [userId, trimmed],
  );
  if (!brain) return null;
  return { brain, access: "owner" };
}

function toLegacy(role: "owner" | "reader" | "editor" | "reviewer" | null): Access {
  if (role === "owner") return "owner";
  if (role === "editor" || role === "reviewer") return "contributor";
  if (role === "reader") return "viewer";
  return null;
}

/** SVOD has no paid locks — kept so callers do not branch on a missing import. */
export async function lockedText(brain: Brain): Promise<string> {
  return `Access to "${brain.title}" is not available on this account.`;
}
