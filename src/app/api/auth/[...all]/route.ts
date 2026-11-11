import { NextResponse } from "next/server";
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

const { GET: authGET, POST: authPOST } = toNextJsHandler(auth);

/**
 * SVOD stage 2 credential serialization + retired self-service endpoints.
 *
 * Email/password sign-in verifies the stored hash and then inserts a session;
 * a password reset rewrites the hash and deletes every session. Without a
 * shared lock, a reset landing between another process's verify and its
 * session insert leaves the old password with a valid session. The sign-in
 * endpoint therefore runs inside this account's PostgreSQL advisory lock
 * (separate small bounded pool, so unrelated queries never wait), for JSON
 * and urlencoded bodies alike — there is no unlocked fallback for a
 * credential request, and DB/parse failures fail closed.
 *
 * Retired outright (404, GET and POST): public signup stays disabled, and
 * self-service password flows that bypass the admin workflow are gone —
 * password reset requests, token-bearing resets and their GET callback,
 * password change/set, profile update and account deletion through this API.
 * The admin rotates passwords in /admin/users; rotation via .env covers the
 * bootstrap account, which keeps signing in here, as do verification,
 * session, sign-out and OAuth flows.
 */

function isSignInEndpoint(pathname: string): boolean {
  return pathname.includes("/sign-in/email");
}

function isRetiredEndpoint(pathname: string): boolean {
  return (
    pathname.includes("/sign-up/email") ||
    pathname.includes("/change-password") ||
    pathname.includes("/set-password") ||
    pathname.includes("/update-user") ||
    pathname.includes("/delete-user") ||
    pathname.includes("/forget-password") ||
    pathname.includes("/request-password-reset") ||
    pathname.includes("/reset-password")
  );
}

/**
 * Exactly one email string, or null. Duplicate `email` keys fail closed:
 * form parsers that overwrite duplicates with the last value would otherwise
 * lock (and authenticate) a different account than the client sent first.
 */
async function readEmail(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const values = (await req.clone().formData()).getAll("email");
      if (values.length !== 1 || typeof values[0] !== "string") return null;
      return values[0] || null;
    }
    const parsed = (await req.clone().json()) as Record<string, unknown>;
    return typeof parsed?.email === "string" ? parsed.email : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  if (isRetiredEndpoint(new URL(req.url).pathname)) {
    return NextResponse.json({ error: "Gone." }, { status: 404 });
  }
  return authGET(req);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  // Retired endpoints fail closed before any delegation — including paths
  // the credential gate below would otherwise pass straight through.
  if (isRetiredEndpoint(url.pathname)) {
    return NextResponse.json({ error: "Gone." }, { status: 404 });
  }
  if (!isSignInEndpoint(url.pathname)) return authPOST(req);

  const { pool } = await import("@/db");
  const { withCredLock, credKeyForUser, credKeyForEmail } = await import("@/lib/cred-lock");

  const bodyEmail = await readEmail(req);
  if (!bodyEmail) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  // Resolve the account row safely: limit 2, never maybeOne — a legacy
  // duplicate pair must serialize on the email key, not throw here. The
  // lookup mirrors the canonical rule (stored email exact equality against
  // the normalized input, which is unique) with a case-insensitive fallback
  // so differently-cased attempts still share one lock.
  const normalized = bodyEmail.trim().toLowerCase();
  let userId: string | null = null;
  try {
    const exact = await pool.query<{ id: string }>(
      `select id from "user" where email = $1 limit 2`,
      [normalized],
    );
    if (exact.rows.length >= 1) {
      userId = exact.rows[0].id;
    } else {
      const folded = await pool.query<{ id: string }>(
        `select id from "user" where lower(email) = lower($1) limit 2`,
        [bodyEmail],
      );
      if (folded.rows.length >= 1) userId = folded.rows[0].id;
    }
  } catch {
    return NextResponse.json({ error: "Unavailable." }, { status: 500 });
  }

  // Unknown address: serialize on the email key so concurrent attempts for
  // the same address still line up.
  const key = userId ? credKeyForUser(userId) : credKeyForEmail(normalized);
  try {
    return await withCredLock(key, () => authPOST(req));
  } catch {
    return NextResponse.json({ error: "Unavailable." }, { status: 503 });
  }
}
