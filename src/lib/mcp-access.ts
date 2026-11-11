import { maybeOne } from "@/db";
import type { Brain, TokenCapability } from "@/db/types";
import type { Access } from "@/lib/access";
import { brainAccessById } from "@/lib/svod-access";
import { getTokenCapability } from "@/lib/svod-token-scopes";

export const TEASER_CALLS = 5;

export interface Resolved {
  brain: Brain;
  access: Access;
  /** SVOD has no paid previews — never set. Kept for caller compatibility. */
  teaser?: { used: number; limit: number };
  locked?: boolean;
  /** SVOD stage 4 live token grant on this brain (null = default deny). */
  tokenCapability: TokenCapability | null;
  canPropose: boolean;
  /** Direct-write: write grant AND project base (DB-trusted). */
  canDirectWrite: boolean;
  isProject: boolean;
}

/**
 * SVOD stage 4 MCP resolution.
 *
 * Authority = user ACL ∩ live token scope, evaluated on every call:
 *   user: owner, brain_members, env operator (shared web policy)
 *   token: mcp_token_scopes row for (token, brain), live (no cache)
 * Unknown and ungranted are uniform (null): callers 404 without distinguishing.
 * Legacy unscoped tokens and OAuth (tokenId "oauth", no scopes) fail closed.
 *
 * Accepts a UUID or "handle/slug" or (for the caller's own bases) a bare
 * slug; bare slugs never resolve across owners. Every branch checks the token
 * boundary BEFORE fetching data beyond the base row itself.
 */

async function inHeldPack(): Promise<boolean> {
  return false;
}

void inHeldPack;

async function withToken(
  brain: Brain,
  access: Access,
  userId: string,
  tokenId: string,
): Promise<Resolved | null> {
  const capability = await getTokenCapability(tokenId, brain.id);
  if (!capability) return null;
  const isProject = (brain as Brain).project_id != null;
  const canPropose = capability === "propose" || capability === "write";
  // Shared rule with svod-token-scopes.resolveTokenBrain: direct-write needs
  // write grant + project base + CURRENT user canEdit (live). Downgraded
  // readers/membership removals immediately lose direct-write.
  const { brainAccessById: liveAccess } = await import("@/lib/svod-access");
  const live = await liveAccess(brain.id, userId);
  const canEdit = live?.canEdit === true;
  const canDirectWrite = capability === "write" && isProject && canEdit;
  return { brain, access, tokenCapability: capability, canPropose, canDirectWrite, isProject };
}

export async function resolveBrain(
  handle: string,
  userId: string,
  tokenId?: string,
): Promise<Resolved | null> {
  const trimmed = handle.trim();
  if (!trimmed) return null;
  // Stage 4 requires an explicit token scope: callers that do not pass a
  // tokenId (legacy paths) fail closed. All retained MCP routes pass it.
  if (!tokenId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenId)) {
    return null;
  }

  if (trimmed.includes("/")) {
    const [maybeOwner, maybeSlug] = trimmed.split("/", 2);
    const { brainAccessByHandleSlug } = await import("@/lib/svod-access");
    const found = await brainAccessByHandleSlug(maybeOwner, maybeSlug, userId);
    if (!found || !found.canRead) return null;
    const access = found.isOperator ? "owner" : toLegacy(found.role);
    if (!access) return null;
    return withToken(found.brain, access, userId, tokenId);
  }

  // UUID: the stable shared identifier — direct lookup with user + token checks.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    const found = await brainAccessById(trimmed, userId);
    if (!found || !found.canRead) return null;
    const access = found.isOperator ? "owner" : toLegacy(found.role);
    if (!access) return null;
    return withToken(found.brain, access, userId, tokenId);
  }

  // Bare slug: only the caller's own bases, exactly as before — never a guess
  // across owners. Token scope still required.
  const brain = await maybeOne<Brain>(
    `select * from brains where owner_id = $1 and slug = $2`,
    [userId, trimmed],
  );
  if (!brain) return null;
  // Owner implies user canRead; token scope decides.
  return withToken(brain, "owner", userId, tokenId);
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
