"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import { pool, query, maybeOne } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/lib/svod-access";
import { withCredLock, credKeyForUser } from "@/lib/cred-lock";

/**
 * SVOD stage 2 operator user management.
 *
 * Every mutation re-checks requireAdmin() — the page guard is not a guard on
 * the action. The environment bootstrap administrator (MOZG_ADMIN_EMAIL) is
 * managed by .env: the UI refuses to edit, reset, delete, or role-manage that
 * principal so a click can never replace it or lock it out.
 *
 * Created users are verified password users with no email/API round-trip:
 * direct "user" + credential "account" rows using Better Auth's own scrypt
 * format. IDs, handles and OAuth rows of existing users are preserved.
 * Passwords are never logged.
 */

const emailRule = z.string().trim().email().max(255);
const passwordRule = z.string().min(8).max(128);
const nameRule = z.string().trim().max(60);

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED = new Set([
  "admin", "api", "b", "beta", "brains", "changelog", "chat", "connect",
  "earn", "explore", "gift", "guide", "make", "mcp", "mind", "pay", "pricing", "r",
  "settings", "sign-in", "sign-up", "vs", "vs-skills", "why", "www",
  "support", "help",
]);

function handleBase(email: string): string {
  return (
    (email.split("@")[0] ?? "user")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "user"
  );
}

function bootstrapEmail(): string | null {
  const raw = env.MOZG_ADMIN_EMAIL?.trim() ?? "";
  return raw ? raw.toLowerCase() : null;
}

function isBootstrapAddress(email: string): boolean {
  const boot = bootstrapEmail();
  return !!boot && normalizeEmail(email) === boot;
}

async function isBootstrapUserId(userId: string): Promise<boolean> {
  const boot = bootstrapEmail();
  if (!boot) return false;
  const row = await maybeOne<{ email: string }>(`select email from "user" where id = $1`, [
    userId,
  ]);
  return !!row && normalizeEmail(row.email) === boot;
}

async function allocateHandle(client: { query: typeof pool.query }, lowerEmail: string): Promise<string> {
  const base = handleBase(lowerEmail);
  const candidates: string[] = [];
  for (let i = 0; i < 20; i++) {
    const c = i === 0 ? base : `${base}-${i}`;
    if (HANDLE_RE.test(c) && !RESERVED.has(c)) candidates.push(c);
  }
  candidates.push(`user-${randomUUID().slice(0, 8).toLowerCase()}`);
  for (const c of candidates) {
    const res = await client.query(
      `select 1 from "user" where handle = $1`,
      [c],
    );
    if (res.rows.length === 0) return c;
  }
  return `user-${randomUUID().slice(0, 8).toLowerCase()}`;
}

export async function createUser(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = z
    .object({ name: nameRule.optional(), email: emailRule, password: passwordRule })
    .safeParse({
      name: String(formData.get("name") ?? "").trim() || undefined,
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
    });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const email = normalizeEmail(parsed.data.email);
  if (isBootstrapAddress(email)) {
    return { error: "That address is the .env bootstrap administrator — managed outside this UI." };
  }
  // Case-insensitive collision: Better Auth signs in with exact equality
  // against the lowercased input, so a mixed-case duplicate 401s or, worse,
  // splits one person's access across two rows. limit 2, never maybeOne —
  // a legacy duplicate pair must surface as "ambiguous", not throw.
  const clashRows = await pool.query<{ id: string }>(
    `select id from "user" where lower(email) = lower($1) limit 2`,
    [email],
  );
  if (clashRows.rows.length > 0) return { error: "An account with that email already exists." };

  const userId = randomUUID();
  const name = parsed.data.name || email.split("@")[0]?.slice(0, 60) || "User";
  const hash = await hashPassword(parsed.data.password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const handle = await allocateHandle(client, email);
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", plan, handle)
       values ($1, $2, $3, true, now(), now(), 'free', $4)`,
      [userId, name, email, handle],
    );
    await client.query(
      `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values ($1, $2, 'credential', $3, $4, now(), now())`,
      [randomUUID(), userId, userId, hash],
    );
    await client.query("commit");
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {}
    // A concurrent creation winning the race surfaces as the same answer.
    if ((err as { code?: string })?.code === "23505") {
      return { error: "An account with that email already exists." };
    }
    throw err;
  } finally {
    client.release();
  }
  console.log(`[admin] ${admin.email} created user ${userId}`);
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function updateUser(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = z
    .object({ id: z.string().min(1), name: nameRule.optional(), email: emailRule })
    .safeParse({
      id: String(formData.get("id") ?? ""),
      name: String(formData.get("name") ?? "").trim() || undefined,
      email: String(formData.get("email") ?? ""),
    });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (await isBootstrapUserId(parsed.data.id)) {
    return { error: "The .env bootstrap administrator is managed outside this UI." };
  }
  const email = normalizeEmail(parsed.data.email);
  if (isBootstrapAddress(email)) {
    return { error: "That address is the .env bootstrap administrator — managed outside this UI." };
  }
  const clashRows = await pool.query<{ id: string }>(
    `select id from "user" where lower(email) = lower($1) and id <> $2 limit 2`,
    [email, parsed.data.id],
  );
  if (clashRows.rows.length > 0) return { error: "Another account already uses that email." };
  const existingRows = await pool.query<{ id: string }>(
    `select id from "user" where id = $1`,
    [parsed.data.id],
  );
  if (existingRows.rows.length !== 1) return { error: "Account not found." };
  // Atomic: one statement, so a concurrent edit cannot interleave. Only
  // name/email change: id, handle, plan and every OAuth row stay intact.
  // emailVerified stays true — operator-created addresses are verified by definition.
  try {
    await query(
      `update "user" set name = coalesce($2, name), email = $3, "emailVerified" = true,
              "updatedAt" = now() where id = $1`,
      [parsed.data.id, parsed.data.name ?? null, email],
    );
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return { error: "Another account already uses that email." };
    }
    throw err;
  }
  console.log(`[admin] ${admin.email} updated user ${parsed.data.id}`);
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function resetUserPassword(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = z
    .object({ id: z.string().min(1), password: passwordRule })
    .safeParse({ id: String(formData.get("id") ?? ""), password: String(formData.get("password") ?? "") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (await isBootstrapUserId(parsed.data.id)) {
    return { error: "The .env bootstrap administrator password is managed via .env, not here." };
  }
  // Serialize with email/password sign-in for this account (auth route holds
  // the same per-user advisory lock around verify+insert-session): a reset
  // landing between another process's verify and its session insert must not
  // leave the old password with a valid session. Bounded waits fail as a
  // busy error, never as an unlocked write.
  try {
    return await withCredLock(credKeyForUser(parsed.data.id), async () => {
      const existingRows = await pool.query<{ email: string }>(
        `select email from "user" where id = $1`,
        [parsed.data.id],
      );
      if (existingRows.rows.length !== 1) return { error: "Account not found." };
      const hash = await hashPassword(parsed.data.password);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const rows = await client.query<{ id: string }>(
          `select id from account where "userId" = $1 and "providerId" = 'credential'`,
          [parsed.data.id],
        );
        if (rows.rows.length === 0) {
          // OAuth-only account gaining its first credential: the surrounding
          // advisory lock serializes concurrent resets so two processes cannot
          // insert duplicate credential rows.
          await client.query(
            `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
             values ($1, $2, 'credential', $3, $4, now(), now())`,
            [randomUUID(), parsed.data.id, parsed.data.id, hash],
          );
        } else {
          for (const r of rows.rows) {
            await client.query(
              `update account set password = $1, "updatedAt" = now() where id = $2`,
              [hash, r.id],
            );
          }
        }
        // Rotation revokes every session so the old password stops working everywhere.
        await client.query(`delete from session where "userId" = $1`, [parsed.data.id]);
        await client.query("commit");
      } catch (err) {
        try {
          await client.query("rollback");
        } catch {}
        throw err;
      } finally {
        client.release();
      }
      console.log(`[admin] ${admin.email} reset password for ${parsed.data.id}`);
      revalidatePath("/admin/users");
      return { ok: true as const };
    });
  } catch {
    return { error: "Busy — try again." };
  }
}

export async function setBrainRole(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = z
    .object({
      userId: z.string().min(1),
      brainId: z.string().uuid(),
      role: z.enum(["reader", "editor", "reviewer"]),
    })
    .safeParse({
      userId: String(formData.get("userId") ?? ""),
      brainId: String(formData.get("brainId") ?? ""),
      role: String(formData.get("role") ?? ""),
    });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const target = await maybeOne<{ email: string }>(`select email from "user" where id = $1`, [
    parsed.data.userId,
  ]);
  if (!target) return { error: "Account not found." };
  // The bootstrap principal's access is the operator bypass, not a grant row —
  // keep it out of the member table so it can never be downgraded by accident.
  if (isBootstrapAddress(target.email)) {
    return { error: "The .env bootstrap administrator already administers every base." };
  }
  const brain = await maybeOne<{ id: string }>(`select id from brains where id = $1`, [
    parsed.data.brainId,
  ]);
  if (!brain) return { error: "Base not found." };
  await query(
    `insert into brain_members (brain_id, user_id, role, granted_by)
     values ($1, $2, $3, $4)
     on conflict (brain_id, user_id)
     do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now()`,
    [parsed.data.brainId, parsed.data.userId, parsed.data.role, admin.id],
  );
  console.log(`[admin] ${admin.email} set ${parsed.data.userId} as ${parsed.data.role} on ${parsed.data.brainId}`);
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function removeBrainRole(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = z
    .object({ userId: z.string().min(1), brainId: z.string().uuid() })
    .safeParse({
      userId: String(formData.get("userId") ?? ""),
      brainId: String(formData.get("brainId") ?? ""),
    });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  await query(`delete from brain_members where brain_id = $1 and user_id = $2`, [
    parsed.data.brainId,
    parsed.data.userId,
  ]);
  console.log(`[admin] ${admin.email} removed ${parsed.data.userId} from ${parsed.data.brainId}`);
  revalidatePath("/admin/users");
  return { ok: true as const };
}
