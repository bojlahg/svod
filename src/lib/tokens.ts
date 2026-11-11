import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { maybeOne, query } from "@/db";
import type { Plan } from "@/db/types";
import { effectivePlan } from "@/lib/plans";

/**
 * MCP access tokens.
 *
 * Stored as a SHA-256 hash — a database dump must not hand anyone a working
 * key. The plaintext is shown once, at creation, and never again.
 */

const PREFIX = "mzg_";

export interface IssuedToken {
  /** Plaintext. Shown once. */
  token: string;
  id: string;
  prefix: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueToken(
  userId: string,
  name?: string,
  opts?: { canCreateProject?: boolean },
): Promise<IssuedToken> {
  const token = PREFIX + randomBytes(24).toString("base64url");
  const prefix = token.slice(0, 12);

  const row = await maybeOne<{ id: string }>(
    `insert into mcp_tokens (user_id, token_hash, prefix, name, can_create_project)
     values ($1, $2, $3, $4, $5) returning id`,
    [userId, hashToken(token), prefix, name ?? null, opts?.canCreateProject === true],
  );

  return { token, id: row!.id, prefix };
}

export interface TokenOwner {
  userId: string;
  tokenId: string;
  plan: Plan;
  /** SVOD stage 4: separate default-off project-creation capability. */
  canCreateProject: boolean;
}

/** Resolve a bearer token to its owner, or null. Also stamps last_used_at. */
export async function verifyToken(raw: string | null): Promise<TokenOwner | null> {
  if (!raw) return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith(PREFIX)) return null;

  const hash = hashToken(token);
  const row = await maybeOne<{
    id: string;
    user_id: string;
    token_hash: string;
    plan: Plan;
    paid_until: Date | null;
    can_create_project: boolean;
  }>(
    `select t.id, t.user_id, t.token_hash, t.can_create_project, u.plan, u.paid_until
       from mcp_tokens t
       join "user" u on u.id = t.user_id
      where t.token_hash = $1 and t.revoked_at is null`,
    [hash],
  );
  if (!row) return null;

  // The lookup already matched on the hash; this is belt-and-braces against a
  // future change that makes the comparison non-constant-time.
  const a = Buffer.from(row.token_hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Fire-and-forget: a failed timestamp update must not fail the tool call.
  void query(`update mcp_tokens set last_used_at = now() where id = $1`, [row.id]).catch(
    () => {},
  );

  // The plan in force, not the plan on the row: an expired paid plan reads
  // as free, so a lapsed month tightens the quota instead of riding on.
  // Stage 4: can_create_project rides with the token (default-off, live).
  return {
    userId: row.user_id,
    tokenId: row.id,
    plan: effectivePlan(row.plan, row.paid_until),
    canCreateProject: row.can_create_project === true,
  };
}

/**
 * Build a TokenOwner from a user id, for the paths that authenticated some
 * other way — today the OAuth MCP session.
 *
 * It exists because that path used to assemble the object by hand from a bare
 * `select plan`, which quietly skipped effectivePlan: an OAuth caller whose
 * paid month had ended kept the paid quota until someone noticed. One place
 * that knows how to answer "who is this and what do they get".
 *
 * SVOD stage 4: OAuth has no mcp_tokens row and therefore no scopes and no
 * create-project grant — it fails closed on every token-scoped route. Callers
 * must use a scoped bearer token from /settings/tokens.
 */
export async function tokenOwnerFor(
  userId: string,
  tokenId: string,
): Promise<TokenOwner | null> {
  const row = await maybeOne<{ plan: Plan; paid_until: Date | null }>(
    `select plan, paid_until from "user" where id = $1`,
    [userId],
  );
  if (!row) return null;
  return { userId, tokenId, plan: effectivePlan(row.plan, row.paid_until), canCreateProject: false };
}

export async function revokeToken(userId: string, tokenId: string): Promise<void> {
  await query(
    `update mcp_tokens set revoked_at = now() where id = $1 and user_id = $2`,
    [tokenId, userId],
  );
}

/**
 * Burst ceiling, separate from the monthly quota. It catches two different
 * things: an agent stuck in a retry loop burning a month's quota in a minute,
 * and someone systematically draining a brain they were given read access to.
 */
const BURST_PER_MINUTE = 60;

export async function burstExceeded(userId: string): Promise<boolean> {
  const row = await maybeOne<{ n: number }>(
    `select count(*)::int as n from calls
      where caller_id = $1 and created_at > now() - interval '1 minute'`,
    [userId],
  );
  return (row?.n ?? 0) >= BURST_PER_MINUTE;
}

/** Live tokens per account. A cap, so a stuck button cannot mint hundreds. */
const MAX_ACTIVE_TOKENS = 20;

export async function issueLimitReached(userId: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `select count(*)::int as n from mcp_tokens
      where user_id = $1 and revoked_at is null`,
    [userId],
  );
  return rows[0].n >= MAX_ACTIVE_TOKENS;
}
