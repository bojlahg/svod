import { maybeOne, query } from "@/db";
import type { Brain } from "@/db/types";
import { env } from "@/lib/env";

/**
 * SVOD stage 2 shared access policy.
 *
 * One place that answers "may this user read / edit / review / administer
 * this brain". Every web action, API route and MCP tool in the retained
 * workspace must go through here — a forgotten check is how a known ID turns
 * into someone else's notes.
 *
 * Roles (additive migration 0093, table brain_members):
 *   reader   — active notes only, no mutations, no pending queue
 *   editor   — reader + edits content (notes, sources, brain fields)
 *   reviewer — editor + approves/rejects pending proposals
 * Owner (brains.owner_id) and the global operator (env MOZG_ADMIN_EMAIL /
 * ADMIN_EMAILS — a server-side identity, never the commercial `plan` column)
 * can administer any base: list, edit, review, manage members, delete.
 *
 * Stable identity: a base is addressed by its UUID or by (owner handle, slug).
 * Slugs are unique per owner only — never resolve a bare slug across owners.
 */

export type SvodMemberRole = "reader" | "editor" | "reviewer";
export type SvodEffectiveRole = "owner" | SvodMemberRole;

export interface BrainAccess {
  brain: Brain;
  /** Null means no access (anonymous or ungranted). */
  role: SvodEffectiveRole | null;
  /** True when the caller is the env-configured operator. */
  isOperator: boolean;
  canRead: boolean;
  canEdit: boolean;
  canReview: boolean;
  canAdmin: boolean;
}

/** Rank for comparisons: reader < editor < reviewer < owner. */
export function roleRank(role: SvodEffectiveRole | null): number {
  switch (role) {
    case "reader":
      return 1;
    case "editor":
      return 2;
    case "reviewer":
      return 3;
    case "owner":
      return 4;
    default:
      return 0;
  }
}

/** Pure policy over a resolved role — no DB, fully unit-testable. */
export function policyForRole(
  role: SvodEffectiveRole | null,
  isOperator: boolean,
): Pick<BrainAccess, "role" | "isOperator" | "canRead" | "canEdit" | "canReview" | "canAdmin"> {
  if (isOperator) {
    return {
      role: role ?? "owner",
      isOperator: true,
      canRead: true,
      canEdit: true,
      canReview: true,
      canAdmin: true,
    };
  }
  switch (role) {
    case "owner":
      return { role, isOperator: false, canRead: true, canEdit: true, canReview: true, canAdmin: true };
    case "reviewer":
      // Reviewer is cumulative: reads, edits and reviews.
      return { role, isOperator: false, canRead: true, canEdit: true, canReview: true, canAdmin: false };
    case "editor":
      return { role, isOperator: false, canRead: true, canEdit: true, canReview: false, canAdmin: false };
    case "reader":
      return { role, isOperator: false, canRead: true, canEdit: false, canReview: false, canAdmin: false };
    default:
      return { role: null, isOperator: false, canRead: false, canEdit: false, canReview: false, canAdmin: false };
  }
}

/** Normalize an address the same way everywhere: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Pure operator check so tests do not need env. */
export function isOperatorEmailPure(
  email: string | null | undefined,
  adminEmails: string,
  bootstrapEmail: string | undefined,
): boolean {
  if (!email) return false;
  const lower = normalizeEmail(email);
  if (!lower) return false;
  const set = new Set(
    [...adminEmails.split(","), bootstrapEmail ?? ""]
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(lower);
}

/** Operator check against the current process env. */
export function isOperatorEmail(email: string | null | undefined): boolean {
  return isOperatorEmailPure(email, env.ADMIN_EMAILS, env.MOZG_ADMIN_EMAIL);
}

async function operatorByUserId(userId: string): Promise<boolean> {
  const row = await maybeOne<{ email: string }>(`select email from "user" where id = $1`, [
    userId,
  ]);
  return isOperatorEmail(row?.email ?? null);
}

async function memberRole(brainId: string, userId: string): Promise<SvodMemberRole | null> {
  const row = await maybeOne<{ role: SvodMemberRole }>(
    `select role from brain_members where brain_id = $1 and user_id = $2`,
    [brainId, userId],
  );
  return row?.role ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed IDs are denial, not a database error: never reach Postgres. */
function isBrainId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Resolve access by brain UUID — the stable identifier. */
export async function brainAccessById(
  brainId: string,
  userId: string | null,
): Promise<BrainAccess | null> {
  if (!isBrainId(brainId)) return null;
  const brain = await maybeOne<Brain>(`select * from brains where id = $1`, [brainId]);
  if (!brain) return null;
  if (!userId) return { brain, ...policyForRole(null, false) };
  const op = await operatorByUserId(userId);
  if (op) return { brain, ...policyForRole(brain.owner_id === userId ? "owner" : null, true) };
  if (brain.owner_id === userId) return { brain, ...policyForRole("owner", false) };
  const role = await memberRole(brain.id, userId);
  return { brain, ...policyForRole(role, false) };
}

/**
 * Resolve access by (owner handle, slug) — the stable human identifier.
 * Never resolves a bare slug: slugs repeat across owners.
 */
export async function brainAccessByHandleSlug(
  handle: string,
  slug: string,
  userId: string | null,
): Promise<BrainAccess | null> {
  const brain = await maybeOne<Brain>(
    `select b.* from brains b join "user" u on u.id = b.owner_id
      where u.handle = $1 and b.slug = $2`,
    [handle, slug],
  );
  if (!brain) return null;
  if (!userId) return { brain, ...policyForRole(null, false) };
  const op = await operatorByUserId(userId);
  if (op) return { brain, ...policyForRole(brain.owner_id === userId ? "owner" : null, true) };
  if (brain.owner_id === userId) return { brain, ...policyForRole("owner", false) };
  const role = await memberRole(brain.id, userId);
  return { brain, ...policyForRole(role, false) };
}

export interface AccessibleBrain extends Brain {
  owner_handle: string | null;
  member_role: SvodEffectiveRole;
}

/**
 * The signed-in workspace list: every base the caller may open.
 * Owned + explicitly granted; the operator sees every base. One query, one
 * ordering — every surface that lists bases must use this, not its own join,
 * so the workspace and MCP agree on what exists.
 */
export async function listAccessibleBrains(userId: string): Promise<AccessibleBrain[]> {
  const op = await operatorByUserId(userId);
  if (op) {
    return query<AccessibleBrain>(
      `select b.*, u.handle as owner_handle,
              case when b.owner_id = $1 then 'owner'
                   else coalesce(m.role, 'owner') end as member_role
         from brains b
         join "user" u on u.id = b.owner_id
         left join brain_members m on m.brain_id = b.id and m.user_id = $1
        order by b.updated_at desc`,
      [userId],
    );
  }
  return query<AccessibleBrain>(
    `select b.*, u.handle as owner_handle,
            case when b.owner_id = $1 then 'owner' else m.role end as member_role
       from brains b
       join "user" u on u.id = b.owner_id
       left join brain_members m on m.brain_id = b.id and m.user_id = $1
      where b.owner_id = $1 or m.role is not null
      order by b.updated_at desc`,
    [userId],
  );
}

/** Convenience for server actions: null when the caller may not read. */
export async function requireCanRead(
  brainId: string,
  userId: string | null,
): Promise<BrainAccess | null> {
  const access = await brainAccessById(brainId, userId);
  if (!access?.canRead) return null;
  return access;
}

/**
 * Workspace route param: a UUID (shared links, always works) or a slug.
 * A slug resolves to the caller's own base first; otherwise to the single
 * accessible member base carrying that slug. Two accessible bases sharing a
 * slug stay ambiguous — open one of them by ID. Slugs are never resolved
 * across owners beyond the caller's own accessible set.
 */
export async function workspaceBrain(
  idOrSlug: string,
  userId: string | null,
): Promise<BrainAccess | null> {
  if (UUID_RE.test(idOrSlug)) return brainAccessById(idOrSlug, userId);
  if (!userId) return null;
  const own = await maybeOne<Brain>(
    `select * from brains where owner_id = $1 and slug = $2`,
    [userId, idOrSlug],
  );
  if (own) {
    const op = await operatorByUserId(userId);
    return { brain: own, ...policyForRole("owner", op) };
  }
  const op = await operatorByUserId(userId);
  if (op) {
    // Operator may open any base by slug when it is unambiguous; otherwise
    // the ID is required so the wrong same-slug base is never opened.
    const rows = await query<Brain>(`select * from brains where slug = $1 limit 2`, [
      idOrSlug,
    ]);
    if (rows.length !== 1) return null;
    return { brain: rows[0], ...policyForRole(null, true) };
  }
  const shared = await query<Brain>(
    `select b.* from brains b
       join brain_members m on m.brain_id = b.id
      where m.user_id = $1 and b.slug = $2
      limit 2`,
    [userId, idOrSlug],
  );
  if (shared.length !== 1) return null;
  const role = await memberRole(shared[0].id, userId);
  return { brain: shared[0], ...policyForRole(role, false) };
}
