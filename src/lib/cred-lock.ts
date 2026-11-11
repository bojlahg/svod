import { Pool, type PoolClient } from "pg";
import { createHash } from "node:crypto";

/**
 * Per-credential advisory locking (SVOD stage 2).
 *
 * Email/password sign-in verifies the stored hash and then inserts a session;
 * a password reset rewrites the hash and deletes every session. Without a
 * shared lock, a reset landing between another process's verify and its
 * session insert leaves the old password with a valid session. The fix is to
 * serialize credential reads/writes per account across processes with a
 * PostgreSQL advisory lock, held for the whole flow on both sides.
 *
 * The lock lives on its own small bounded pool — never on Better Auth's
 * ordinary pool — so a slow sign-in cannot starve unrelated queries. Locks
 * are session-level (explicit lock + unlock on one checked-out connection):
 * the flows they guard span several pooled transactions internally, so a
 * transaction-scoped lock would release halfway through. Keys are 64-bit
 * (first 64 bits of sha256, passed as a bigint param); lock waits are
 * bounded by a try-lock loop, and pool checkout waits are bounded by
 * connectionTimeoutMillis. allowExitOnIdle lets the bootstrap CLI exit
 * immediately after using the pool.
 */

const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 50;

const globalForLock = globalThis as unknown as { _svodCredPool?: Pool };

function lockPool(): Pool {
  globalForLock._svodCredPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  return globalForLock._svodCredPool;
}

/** 64-bit advisory key as a decimal string (pg serializes it as int8). */
export function credKey64(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 16);
  // PostgreSQL bigint is signed: fold the top bit into the sign so a key
  // whose hash has the high bit set still fits in int8 instead of erroring
  // (which surfaced as 503s on valid logins).
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

/** Stable lock name for one account's credential flows. */
export function credKeyForUser(userId: string): string {
  return `svod:cred:user:${userId}`;
}

/** Fallback when the account row is not known yet (unknown email). */
export function credKeyForEmail(email: string): string {
  return `svod:cred:email:${email.trim().toLowerCase()}`;
}

async function acquire(client: PoolClient, key64: string, deadline: number): Promise<boolean> {
  for (;;) {
    const res = await client.query<{ ok: boolean }>(
      `select pg_try_advisory_lock($1::bigint) as ok`,
      [key64],
    );
    if (res.rows[0]?.ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * Run `fn` with this account's credential lock held across processes.
 * Concurrent holders serialize; distinct accounts never block each other.
 * Lock waits are bounded — on timeout this throws and the caller fails
 * closed (503 / busy), never silently unlocked.
 */
export async function withCredLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const pool = lockPool();
  const client = await pool.connect();
  const key64 = credKey64(key);
  let locked = false;
  try {
    locked = await acquire(client, key64, Date.now() + LOCK_WAIT_MS);
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  if (!locked) {
    client.release();
    throw new Error("credential lock timeout");
  }
  try {
    return await fn();
  } finally {
    try {
      await client.query(`select pg_advisory_unlock($1::bigint)`, [key64]);
      client.release();
    } catch (err) {
      // An unlock error leaves the lock state unknown — destroy the
      // connection instead of returning a potentially locked one to the pool.
      client.release(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
