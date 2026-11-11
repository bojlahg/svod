import { maybeOne, query } from "@/db";
import type { Brain, TokenCapability } from "@/db/types";
import { brainAccessById, isOperatorEmail } from "@/lib/svod-access";

/**
 * SVOD stage 4 shared live token-scope resolver.
 *
 * One place that answers "may this TOKEN touch this BRAIN, and how".
 * Every MCP tool, the HTTP bearer notes endpoint and the token-grant UI go
 * through here — a forgotten check is how a known ID turns into someone
 * else's notes.
 *
 * Model:
 *   - One token explicitly selects several brain UUIDs with read,
 *     read+propose, and (project bases only) read+direct-write.
 *   - Default deny: no scope row = no access. Legacy unscoped tokens and
 *     OAuth (tokenId "oauth", no mcp_tokens row) fail closed.
 *   - Separate default-off create-project capability on mcp_tokens.
 *   - Access = user ACL ∩ token scope, evaluated live on every call:
 *     user must canRead via brain_members/owner/operator AND token must hold
 *     a scope row for that brain. Revocation/grant updates apply immediately
 *     (no cache).
 *   - Native guards: FK/unique on mcp_token_scopes, plus DB trigger rejecting
 *     write grants on general bases (brains.project_id IS NULL). Code also
 *     re-checks brains.project_id from DB and never trusts a caller-provided
 *     project/base flag — a forged scope flag cannot authorize a general-base
 *     direct write.
 */

export type { TokenCapability };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export interface TokenScopeRow {
  brain_id: string;
  capability: TokenCapability;
}

/** Live scopes for one token: no cache, so grants/revokes apply immediately. */
export async function getTokenScopes(tokenId: string): Promise<Map<string, TokenCapability>> {
  if (!isUuid(tokenId)) return new Map();
  const rows = await query<TokenScopeRow>(
    `select s.brain_id, s.capability
       from mcp_token_scopes s
       join mcp_tokens t on t.id = s.token_id
      where s.token_id = $1 and t.revoked_at is null`,
    [tokenId],
  );
  const map = new Map<string, TokenCapability>();
  for (const r of rows) map.set(r.brain_id, r.capability);
  return map;
}

export async function getTokenCapability(
  tokenId: string,
  brainId: string,
): Promise<TokenCapability | null> {
  if (!isUuid(tokenId) || !isUuid(brainId)) return null;
  const row = await maybeOne<{ capability: TokenCapability }>(
    `select s.capability
       from mcp_token_scopes s
       join mcp_tokens t on t.id = s.token_id
      where s.token_id = $1 and s.brain_id = $2 and t.revoked_at is null`,
    [tokenId, brainId],
  );
  return row?.capability ?? null;
}

/** Separate default-off project-creation capability. Revoked tokens fail closed. */
export async function tokenCanCreateProject(tokenId: string): Promise<boolean> {
  if (!isUuid(tokenId)) return false;
  const row = await maybeOne<{ can_create_project: boolean }>(
    `select can_create_project from mcp_tokens where id = $1 and revoked_at is null`,
    [tokenId],
  );
  return row?.can_create_project === true;
}

export interface TokenBrainAccess {
  brain: Brain;
  /** User role via shared web policy (owner/member/operator), null = no user access. */
  userCanRead: boolean;
  userCanReview: boolean;
  userCanEdit: boolean;
  /** Token scope on this brain, null = no grant (default deny). */
  capability: TokenCapability | null;
  canRead: boolean;
  canPropose: boolean;
  /** Direct-write: write grant AND project base (DB-trusted, never caller flag). */
  canDirectWrite: boolean;
  isProject: boolean;
}

/**
 * Intersect user ACL and token scope on one brain.
 * Unknown and ungranted are uniform: null when either side denies, so callers
 * 404 without distinguishing them.
 *
 * Direct-write additionally intersects current user canEdit: downgrading a
 * user's edit rights (or removing membership) immediately disables their old
 * write token, even though the scope row still exists.
 */
export async function resolveTokenBrain(
  brainId: string,
  userId: string,
  tokenId: string,
): Promise<TokenBrainAccess | null> {
  if (!isUuid(brainId) || !userId || !isUuid(tokenId)) return null;
  const access = await brainAccessById(brainId, userId);
  if (!access) return null;
  const brain = access.brain;
  const isProject = (brain as Brain).project_id != null;
  if (!access.canRead) return null;
  const capability = await getTokenCapability(tokenId, brain.id);
  if (!capability) return null;
  const canRead = true;
  const canPropose = capability === "propose" || capability === "write";
  // Trusted: write grant on a project base only AND current user canEdit.
  // A forged scope flag on a general base cannot pass because isProject comes
  // from the DB row; a downgraded reader cannot pass because canEdit is live.
  const canDirectWrite = capability === "write" && isProject && access.canEdit;
  return {
    brain,
    userCanRead: access.canRead,
    userCanReview: access.canReview,
    userCanEdit: access.canEdit,
    capability,
    canRead,
    canPropose,
    canDirectWrite,
    isProject,
  };
}

export interface TokenAccessibleBrain extends Brain {
  capability: TokenCapability;
  owner_handle: string | null;
}

/**
 * Every base this token may open: user canRead ∩ live token scope.
 * Single source for MCP list and multi-base search — the workspace and MCP
 * agree on what exists because they share the user half (listAccessibleBrains
 * logic) intersected here with the token half.
 */
export async function listTokenBrains(
  userId: string,
  tokenId: string,
): Promise<TokenAccessibleBrain[]> {
  if (!userId || !isUuid(tokenId)) return [];
  // Operator sees every base on the user half; token half still required.
  const opRow = await maybeOne<{ email: string }>(`select email from "user" where id = $1`, [
    userId,
  ]);
  const isOp = isOperatorEmail(opRow?.email ?? null);
  const rows = isOp
    ? await query<TokenAccessibleBrain & { owner_handle: string | null }>(
        `select b.*, u.handle as owner_handle, s.capability
           from brains b
           join "user" u on u.id = b.owner_id
           join mcp_token_scopes s on s.brain_id = b.id
           join mcp_tokens t on t.id = s.token_id
          where s.token_id = $1 and t.revoked_at is null
          order by b.updated_at desc`,
        [tokenId],
      )
    : await query<TokenAccessibleBrain & { owner_handle: string | null }>(
        `select b.*, u.handle as owner_handle, s.capability
           from brains b
           join "user" u on u.id = b.owner_id
           join mcp_token_scopes s on s.brain_id = b.id
           join mcp_tokens t on t.id = s.token_id
           left join brain_members m on m.brain_id = b.id and m.user_id = $2
          where s.token_id = $1 and t.revoked_at is null
            and (b.owner_id = $2 or m.role is not null)
          order by b.updated_at desc`,
        [tokenId, userId],
      );
  return rows;
}

/**
 * Grant guard for the token UI: what may this issuer grant on this brain?
 *
 * Admin (operator email) may grant any private base with any capability
 * except write-on-general (rejected natively anyway). Ordinary issuers may
 * only grant bases in their current web membership (canRead) and only
 * capabilities their own role allows:
 *   reader   -> read only
 *   editor   -> read, propose
 *   reviewer -> read, propose (review does not confer direct-write)
 *   owner    -> read, propose; write only when the base is a project base
 *              they own or can edit? Owners may grant write on project bases
 *              they administer; editors may grant write only when they canEdit
 *              the project base (same rule, uniform).
 * Direct-write additionally requires a project base (DB-trusted).
 */
export async function grantableCapabilities(
  brainId: string,
  issuerUserId: string,
): Promise<{ ok: boolean; reason?: string; allowed: TokenCapability[] }> {
  if (!isUuid(brainId) || !issuerUserId) return { ok: false, reason: "Base not found.", allowed: [] };
  const access = await brainAccessById(brainId, issuerUserId);
  if (!access) return { ok: false, reason: "Base not found.", allowed: [] };
  const brain = access.brain as Brain;
  const isProject = brain.project_id != null;
  if (access.isOperator) {
    // Admin may grant any base; write still only on project bases.
    return { ok: true, allowed: isProject ? ["read", "propose", "write"] : ["read", "propose"] };
  }
  if (!access.canRead) return { ok: false, reason: "Base not found.", allowed: [] };
  if (access.role === "reader") return { ok: true, allowed: ["read"] };
  if (access.role === "editor" || access.role === "reviewer") {
    // Editors/reviewers may share read/propose; direct-write needs canEdit on
    // a project base (they have it as editors).
    if (isProject && access.canEdit) return { ok: true, allowed: ["read", "propose", "write"] };
    return { ok: true, allowed: ["read", "propose"] };
  }
  if (access.role === "owner") {
    if (isProject) return { ok: true, allowed: ["read", "propose", "write"] };
    return { ok: true, allowed: ["read", "propose"] };
  }
  return { ok: false, reason: "Base not found.", allowed: [] };
}

/** Validate a project_id from an agent: trimmed, 1-200, no CR/LF. */
export function validateProjectId(raw: unknown): { ok: true; projectId: string } | { ok: false; error: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "A project_id is required — the stable external project ID, not the display title." };
  if (s.length > 200) return { ok: false, error: "project_id is too long (max 200)." };
  if (/[\r\n]/.test(s)) return { ok: false, error: "project_id cannot contain line breaks." };
  return { ok: true, projectId: s };
}

export function isProjectBrain(brain: Pick<Brain, "project_id">): boolean {
  return brain.project_id != null;
}

/**
 * Token-aware family scope: parent + children the TOKEN may open (user ∩ token).
 * Resolving the parent says nothing about its children — without this filter
 * asking a permitted parent becomes a way to read an ungranted child.
 */
export async function familyScopeForToken(
  brain: Pick<Brain, "id" | "parent_id">,
  userId: string,
  tokenId: string,
): Promise<string[]> {
  if (brain.parent_id) {
    // Child reaches only itself (narrow stays narrow).
    return [brain.id];
  }
  const { query } = await import("@/db");
  const kids = await query<{ id: string }>(`select id from brains where parent_id = $1`, [brain.id]);
  const scopes = await getTokenScopes(tokenId);
  const out = [brain.id];
  const { brainAccessById } = await import("@/lib/svod-access");
  for (const k of kids) {
    if (!scopes.has(k.id)) continue;
    const access = await brainAccessById(k.id, userId);
    if (!access?.canRead) continue;
    out.push(k.id);
  }
  return out;
}

export async function accessibleChildrenForToken(
  parentId: string,
  userId: string,
  tokenId: string,
): Promise<{ id: string; slug: string; title: string; goal: string | null; score: number | null; note_count: number }[]> {
  const { query } = await import("@/db");
  const kids = await query<{ id: string; slug: string; title: string; goal: string | null; score: number | null; note_count: number }>(
    `select id, slug, title, goal, score, note_count from brains where parent_id = $1 order by title`,
    [parentId],
  );
  const scopes = await getTokenScopes(tokenId);
  const { brainAccessById } = await import("@/lib/svod-access");
  const out: typeof kids = [];
  for (const k of kids) {
    if (!scopes.has(k.id)) continue;
    const access = await brainAccessById(k.id, userId);
    if (!access?.canRead) continue;
    out.push(k);
  }
  return out;
}
