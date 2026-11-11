"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { tx } from "@/db";
import { randomBytes } from "node:crypto";
import { currentUser } from "@/lib/session";
import { revokeToken, issueLimitReached, hashToken } from "@/lib/tokens";
import { grantableCapabilities } from "@/lib/svod-token-scopes";
import type { TokenCapability } from "@/db/types";
import {
  ichiIssueLimitReached,
  issueIchiToken,
  revokeIchiToken,
} from "@/lib/ichi-tokens";

/**
 * SVOD stage 4 scoped tokens: one token selects several brain UUIDs with
 * read / read+propose / read+direct-write (project only), plus a separate
 * default-off create-project grant. Default deny, live resolver, immediate
 * revocation. Plaintext shown once, never stored.
 *
 * Atomicity: the requested token+scope configuration commits as one
 * transaction (token row + can_create_project + scope rows). Ownership and
 * revoked state are locked/rechecked inside that transaction; constraint or
 * validation failures roll everything back with visible feedback instead of
 * announcing success with dropped grants. No swallowed SQL errors.
 */

const PREFIX = "mzg_";

function parseScopes(formData: FormData): { brainId: string; capability: TokenCapability }[] {
  const out: { brainId: string; capability: TokenCapability }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("scope:")) continue;
    const brainId = key.slice("scope:".length);
    const cap = String(value);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brainId)) continue;
    if (cap !== "read" && cap !== "propose" && cap !== "write") continue;
    out.push({ brainId, capability: cap });
  }
  return out;
}

export async function createToken(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  if (await issueLimitReached(user.id)) {
    return { error: "You already have 20 active tokens. Revoke some below first." };
  }

  const name = String(formData.get("name") ?? "").trim().slice(0, 60);
  const canCreateProject = formData.get("can_create_project") === "on";
  const requested = parseScopes(formData);

  // Strict pre-validation (grantable + project-only write) so the transaction
  // never hits an expected constraint error. Anything unexpected rolls back
  // with a visible error and issues nothing.
  const scopes: typeof requested = [];
  for (const s of requested) {
    const g = await grantableCapabilities(s.brainId, user.id);
    if (!g.ok) return { error: `Base ${s.brainId.slice(0, 8)} is not available to grant.` };
    if (!g.allowed.includes(s.capability)) {
      return { error: `Grant ${s.capability} is not allowed on that base (write is project bases only).` };
    }
    scopes.push(s);
  }

  const token = PREFIX + randomBytes(24).toString("base64url");
  const prefix = token.slice(0, 12);
  try {
    const id = await tx(async (client) => {
      const rows = await client.query<{ id: string }>(
        `insert into mcp_tokens (user_id, token_hash, prefix, name, can_create_project)
         values ($1, $2, $3, $4, $5) returning id`,
        [user.id, hashToken(token), prefix, name || null ? name : null, canCreateProject],
      );
      const tokenId = rows.rows[0].id;
      for (const s of scopes) {
        await client.query(
          `insert into mcp_token_scopes (token_id, brain_id, capability, granted_by)
           values ($1, $2, $3, $4)`,
          [tokenId, s.brainId, s.capability, user.id],
        );
      }
      return tokenId;
    });
    void id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as { code?: string })?.code === "23505") {
      return { error: "That configuration collided. Retry the creation." };
    }
    if ((e as { code?: string })?.code === "23514") {
      return { error: "Write grants are project bases only. Adjust scopes and retry." };
    }
    console.error("[tokens] create failed:", msg);
    return { error: "Could not create the token with those scopes. Nothing was issued." };
  }

  revalidatePath("/settings/tokens");
  return { token };
}

export async function updateTokenScopes(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const tokenId = String(formData.get("id") ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenId)) {
    return { error: "Token not found." };
  }
  const canCreateProject = formData.get("can_create_project") === "on";
  const requested = parseScopes(formData);
  const scopes: typeof requested = [];
  for (const s of requested) {
    const g = await grantableCapabilities(s.brainId, user.id);
    if (!g.ok) return { error: `Base ${s.brainId.slice(0, 8)} is not available to grant.` };
    if (!g.allowed.includes(s.capability)) {
      return { error: `Grant ${s.capability} is not allowed on that base (write is project bases only).` };
    }
    scopes.push(s);
  }
  const wanted = new Map(scopes.map((s) => [s.brainId, s.capability]));
  try {
    await tx(async (client) => {
      // Lock + recheck ownership and revoked state inside the transaction.
      const lock = await client.query<{ id: string }>(
        `select id from mcp_tokens where id = $1 and user_id = $2 and revoked_at is null for update`,
        [tokenId, user.id],
      );
      if (!lock.rowCount) throw Object.assign(new Error("Token not found."), { code: "TOKEN_MISSING" });
      await client.query(`update mcp_tokens set can_create_project = $2 where id = $1`, [tokenId, canCreateProject]);
      await client.query(`delete from mcp_token_scopes where token_id = $1 and brain_id <> all($2::uuid[])`, [
        tokenId,
        [...wanted.keys()],
      ]);
      for (const [brainId, capability] of wanted) {
        await client.query(
          `insert into mcp_token_scopes (token_id, brain_id, capability, granted_by)
           values ($1, $2, $3, $4)
           on conflict (token_id, brain_id) do update set capability = $3, granted_by = $4`,
          [tokenId, brainId, capability, user.id],
        );
      }
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "TOKEN_MISSING") return { error: "Token not found." };
    if ((e as { code?: string })?.code === "23514") {
      return { error: "Write grants are project bases only. Nothing was changed." };
    }
    console.error("[tokens] update failed:", e instanceof Error ? e.message : String(e));
    return { error: "Could not save those scopes. Nothing was changed." };
  }
  revalidatePath("/settings/tokens");
  return { ok: true as const };
}

export async function revoke(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  await revokeToken(user.id, String(formData.get("id")));
  revalidatePath("/settings/tokens");
}

/**
 * The same two actions for ichi's tokens. Separate functions rather than a
 * `product` parameter: they write to different tables with different caps, and
 * a single action branching on a form field is one typo away from minting the
 * wrong kind of credential.
 */
export async function createIchiToken(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  if (await ichiIssueLimitReached(user.id)) {
    return { error: "You already have 20 active ichi tokens. Revoke some below first." };
  }

  const name = String(formData.get("name") ?? "").trim().slice(0, 60);
  const issued = await issueIchiToken(user.id, name || undefined);

  revalidatePath("/settings/tokens");
  return { token: issued.token };
}

export async function revokeIchi(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  await revokeIchiToken(user.id, String(formData.get("id")));
  revalidatePath("/settings/tokens");
}
