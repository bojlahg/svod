import { hashPassword, verifyPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { z } from "zod";

/**
 * Self-host administrator bootstrap (SVOD stage 1).
 *
 * Provisions a real Better Auth email+password credential for MOZG_ADMIN_EMAIL:
 * - creates the user when none exists (case-insensitive email lookup),
 * - on a single case-insensitive match normalizes the stored email to
 *   lowercase atomically — Better Auth's sign-in lookup is exact equality
 *   against the lowercased input, so a mixed-case stored address 401s —
 *   while preserving the user id, handle and any OAuth account rows,
 * - links a `credential` account onto an existing OAuth-only account without
 *   touching other provider rows,
 * - verifies the stored scrypt hash before writing so a repeat run with the
 *   same password is a no-op (no session churn),
 * - on a password change writes the new hash and deletes all sessions so the
 *   old password stops working everywhere.
 *
 * Existing nonempty handles are kept as-is (they may already be used in
 * workspace URLs); a handle is only generated when the row has none, and it
 * must satisfy the settings-page shape and the unique index. All handle
 * attempts run under savepoints so a taken handle rolls back just the
 * attempt instead of aborting the whole transaction (SQLSTATE 25P02).
 *
 * Never logs the password or its hash — errors name the step, never the
 * secret. All user+account+session writes happen in one transaction guarded
 * by a transaction-scoped advisory lock, so parallel startups serialize.
 */

const adminEmailRule = z.string().trim().email();

export function validateAdminEnv(
  email: string | undefined,
  password: string | undefined,
): { email: string; password: string } {
  // Same email rule as env.ts (zod), trimmed — but passwords stay literal
  // (see below). Runs before any migration or DB write.
  const parsed = adminEmailRule.safeParse(email ?? "");
  if (!parsed.success) {
    throw new Error(
      "MOZG_ADMIN_EMAIL is missing or not an email — set it in .env (see .env.selfhost.example)",
    );
  }
  const e = parsed.data;
  // Password is literal: no trim, no normalization. better-auth hashes the
  // exact bytes (NFKC inside scrypt), so trimming here would lock the admin
  // out when the password has leading/trailing spaces.
  if (!password || password.length < 8) {
    throw new Error(
      "MOZG_ADMIN_PASSWORD is missing or too short (min 8 chars) — set it in .env (see .env.selfhost.example)",
    );
  }
  if (password.length > 128) {
    throw new Error("MOZG_ADMIN_PASSWORD is too long (max 128 chars)");
  }
  return { email: e, password };
}

export interface BootstrapResult {
  status: "created" | "linked" | "rotated" | "unchanged";
  userId: string;
  handle: string | null;
}

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const RESERVED_HANDLES = new Set([
  "admin", "api", "b", "beta", "brains", "changelog", "chat", "connect",
  "earn", "explore", "gift", "guide", "make", "mcp", "mind", "pay", "pricing", "r",
  "settings", "sign-in", "sign-up", "vs", "vs-skills", "why", "www",
  "support", "help",
]);

function handleBaseFromEmail(email: string): string {
  const base =
    (email.split("@")[0] ?? "user")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "user";
  return base;
}

function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle) && !RESERVED_HANDLES.has(handle.toLowerCase());
}

function handleCandidates(base: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 20; i++) out.push(i === 0 ? base : `${base}-${i}`);
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

function constraintOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const c = (err as { constraint?: unknown }).constraint;
  return typeof c === "string" ? c : null;
}

/** Only a clash on the handle index may be retried with the next candidate. */
function isHandleUniqueViolation(err: unknown): boolean {
  return isUniqueViolation(err) && constraintOf(err) === "user_handle_key";
}

interface UserRow {
  id: string;
  email: string;
  handle: string | null;
}

/**
 * Insert a brand-new admin user with a valid unique handle. Collisions with
 * handles other accounts already hold roll back just the attempt
 * (savepoint), so a taken handle can never abort the transaction.
 */
async function insertAdminUser(
  client: Client,
  userId: string,
  lowerEmail: string,
  name: string,
): Promise<string> {
  const candidates = [
    ...handleCandidates(handleBaseFromEmail(lowerEmail)).filter(isValidHandle),
    `user-${randomUUID().slice(0, 8).toLowerCase()}`,
  ];
  let n = 0;
  for (const candidate of candidates) {
    if (!isValidHandle(candidate)) continue;
    const sp = `svod_admin_handle_${n++}`;
    await client.query(`savepoint ${sp}`);
    try {
      await client.query(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", plan, handle)
         values ($1, $2, $3, true, now(), now(), 'admin', $4)`,
        [userId, name, lowerEmail, candidate],
      );
      await client.query(`release savepoint ${sp}`);
      return candidate;
    } catch (err) {
      await client.query(`rollback to savepoint ${sp}`);
      await client.query(`release savepoint ${sp}`).catch(() => {});
      // Only a handle clash retries with the next candidate. Anything else
      // (an email clash from a concurrent insert, a dead connection, …)
      // fails explicitly instead of looping through candidates.
      if (isHandleUniqueViolation(err)) continue;
      if (isUniqueViolation(err)) {
        throw new Error("admin account appeared during bootstrap; restart to pick it up");
      }
      throw err;
    }
  }
  throw new Error("could not allocate a unique handle for the admin account");
}

/**
 * Fill a missing handle on an existing user. A present handle — valid or
 * not — is left untouched: it may already be used in workspace URLs.
 */
async function fillMissingHandle(
  client: Client,
  userId: string,
  lowerEmail: string,
): Promise<string | null> {
  const candidates = [
    ...handleCandidates(handleBaseFromEmail(lowerEmail)).filter(isValidHandle),
    `user-${randomUUID().slice(0, 8).toLowerCase()}`,
  ];
  let n = 0;
  for (const candidate of candidates) {
    if (!isValidHandle(candidate)) continue;
    const sp = `svod_admin_handle_${n++}`;
    await client.query(`savepoint ${sp}`);
    let updated = 0;
    try {
      // Only the UPDATE runs under the savepoint. The rowCount check and
      // the re-SELECT below run after RELEASE, so their errors can never
      // issue ROLLBACK TO a released savepoint.
      const res = await client.query(
        `update "user" set handle = $1 where id = $2 and (handle is null or handle = '')`,
        [candidate, userId],
      );
      updated = res.rowCount ?? 0;
      await client.query(`release savepoint ${sp}`);
    } catch (err) {
      await client.query(`rollback to savepoint ${sp}`);
      await client.query(`release savepoint ${sp}`).catch(() => {});
      // Only a handle-index clash retries; anything else fails explicitly.
      if (isHandleUniqueViolation(err)) continue;
      throw err;
    }
    if (updated > 0) return candidate;
    const cur = await client.query<Pick<UserRow, "handle">>(
      `select handle from "user" where id = $1`,
      [userId],
    );
    const h = cur.rows[0]?.handle ?? null;
    if (h) return h;
  }
  throw new Error("could not set a unique handle for the admin account");
}

/**
 * Provision the configured administrator. The caller owns the connection.
 * Runs BEGIN/COMMIT internally so user+account+session changes are atomic.
 */
export async function ensureAdminWithClient(
  client: Client,
  rawEmail: string,
  rawPassword: string,
): Promise<BootstrapResult> {
  const { email, password } = validateAdminEnv(rawEmail, rawPassword);
  const lowerEmail = email.toLowerCase();

  await client.query("begin");
  try {
    // Serialize parallel app startups. Transaction-scoped: released on
    // commit/rollback, which is exactly the window the user+account writes
    // need. The unique indexes stay the real guard after that.
    await client.query(`select pg_advisory_xact_lock(hashtext('svod_admin_bootstrap'))`);

    const found = await client.query<UserRow>(
      `select id, email, handle from "user" where lower(email) = lower($1)`,
      [email],
    );
    if (found.rows.length > 1) {
      throw new Error(
        `multiple accounts match ${lowerEmail} (case-insensitive); refusing to choose — merge or rename them first`,
      );
    }

    let userId: string;
    let handle: string | null;

    if (found.rows.length === 0) {
      userId = randomUUID();
      const name = email.split("@")[0]?.slice(0, 60) || "Admin";
      handle = await insertAdminUser(client, userId, lowerEmail, name);
    } else {
      const row = found.rows[0];
      userId = row.id;
      // One conditional write: normalize the stored email to lowercase
      // (Better Auth's sign-in lookup is exact equality against the
      // lowercased input, so a mixed-case stored address 401s), confirm the
      // address and promote to the operator plan. A repeat run with nothing
      // to change updates zero rows, so "unchanged" really is a no-op:
      // updatedAt, the hash and the sessions stay exactly as they were.
      // The id, the handle and every OAuth account row are untouched.
      await client.query(
        `update "user" set email = $2, "emailVerified" = true, plan = 'admin', "updatedAt" = now()
          where id = $1
            and (email is distinct from $2
              or not "emailVerified"
              or plan is distinct from 'admin')`,
        [userId, lowerEmail],
      );
      handle = row.handle ?? null;
      if (!handle) handle = await fillMissingHandle(client, userId, lowerEmail);
    }

    const accounts = await client.query<{ id: string; password: string | null }>(
      `select id, password from account where "userId" = $1 and "providerId" = 'credential'`,
      [userId],
    );

    if (accounts.rows.length === 0) {
      const hash = await hashPassword(password);
      await client.query(
        `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         values ($1, $2, 'credential', $3, $4, now(), now())`,
        [randomUUID(), userId, userId, hash],
      );
      // Whenever a new password is set, prior sessions go — for a brand-new
      // user this is a no-op; for a first link it ends pre-existing OAuth
      // sessions so the rotation rule stays simple.
      await client.query(`delete from session where "userId" = $1`, [userId]);
      await client.query("commit");
      return { status: found.rows.length === 0 ? "created" : "linked", userId, handle };
    }

    // Credential row(s) exist. Verify before writing: the same password
    // must be a strict no-op that leaves sessions alone.
    let anyValid = false;
    let allValid = true;
    for (const row of accounts.rows) {
      if (!row.password) {
        allValid = false;
        continue;
      }
      try {
        if (await verifyPassword({ hash: row.password, password })) anyValid = true;
        else allValid = false;
      } catch {
        allValid = false;
      }
    }
    if (anyValid && allValid) {
      await client.query("commit");
      return { status: "unchanged", userId, handle };
    }

    // Rotation (or a first password on a row with a null/legacy hash): one
    // new hash for every credential row so no stale password survives, then
    // drop every session so the old password stops working everywhere.
    const newHash = await hashPassword(password);
    for (const row of accounts.rows) {
      await client.query(`update account set password = $1, "updatedAt" = now() where id = $2`, [
        newHash,
        row.id,
      ]);
    }
    await client.query(`delete from session where "userId" = $1`, [userId]);

    await client.query("commit");
    return { status: "rotated", userId, handle };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // Original error wins.
    }
    throw err;
  }
}
