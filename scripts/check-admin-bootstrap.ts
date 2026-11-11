/**
 * Repeatable live-PostgreSQL check for the self-host admin bootstrap.
 *
 * Requires an explicitly supplied test database — it never touches the dev
 * database and refuses to guess one:
 *
 *   SVOD_TEST_DATABASE_URL=postgres://mozg:mozg@localhost:5433/mozg-test \
 *     npm run check:admin-bootstrap
 *
 * Exercises the same path scripts/selfhost-start.ts runs on every boot:
 * fresh create, real Better Auth password sign-in, no-op with sessions,
 * timestamps and hash preserved, rotation with sessions revoked and the old
 * password dead, linking onto a mixed-case OAuth-only account (stored email
 * normalized so sign-in works, id/handle/OAuth row preserved), handle
 * collision without aborting the boot, and refusal on ambiguous
 * case-folded duplicates. All fixtures use throwaway addresses and are
 * deleted in `finally` (user rows cascade to account/session). Fails
 * nonzero with context; messages never carry a password or hash.
 */
import { Client } from "pg";

async function main() {
  const TEST_DSN = process.env.SVOD_TEST_DATABASE_URL;
  if (!TEST_DSN) {
    console.error(
      "\nadmin bootstrap integration FAILED: SVOD_TEST_DATABASE_URL is required — " +
        "point it at a disposable database, never at dev or production.",
    );
    process.exit(1);
  }

  // The app modules below read env at import time, so the test database and
  // a test-only signing secret go in first. The secret below signs nothing
  // real: every fixture is deleted at the end of the run.
  process.env.DATABASE_URL = TEST_DSN;
  process.env.BETTER_AUTH_SECRET ??=
    "svod-admin-bootstrap-check-secret-please-rotate-if-reused";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3300";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3300";

  const { ensureAdminWithClient } = await import("../src/lib/admin-bootstrap");
  const { auth } = await import("../src/lib/auth");
  const { pool } = await import("../src/db");

  function step(msg: string) {
    console.log(`· ${msg}`);
  }

  async function signInOk(email: string, password: string): Promise<string> {
    const res = (await auth.api.signInEmail({
      body: { email, password },
      headers: new Headers(),
    })) as unknown as { user?: { id?: string } };
    const id = res?.user?.id;
    if (!id) throw new Error("sign-in succeeded without a user id");
    return id;
  }

  async function signInUnauthorized(email: string, password: string): Promise<void> {
    try {
      await auth.api.signInEmail({ body: { email, password }, headers: new Headers() });
    } catch (err) {
      // Better Auth's error carries status="UNAUTHORIZED" (string) with the
      // numeric code on statusCode — check the number first.
      const status =
        (err as { statusCode?: number })?.statusCode ?? (err as { status?: number })?.status;
      if (status === 401) return;
      throw new Error(`expected a 401 for a bad password, got status ${String(status)}`);
    }
    throw new Error("sign-in with a bad password unexpectedly succeeded");
  }

  const stamp = Date.now().toString(36);
  const client = new Client({ connectionString: TEST_DSN });
  const fixtureIds: string[] = [];
  const track = (id: string) => fixtureIds.push(id);

  await client.connect();
  try {
    // Identity tables must exist — migrations run separately against the test
    // database (npm run db:migrate with DATABASE_URL set to it).
    await client.query(`select 1 from "user" limit 1`).catch(() => {
      throw new Error("identity tables missing — run migrations against the test database first");
    });

    // ── 1. fresh create + real sign-in ────────────────────────────────
    const freshEmail = `admin-fresh-${stamp}@example.test`;
    const freshPw1 = `fresh-pw-1-${stamp}-xxxx`;
    step(`create ${freshEmail}`);
    const created = await ensureAdminWithClient(client, freshEmail, freshPw1);
    if (created.status !== "created") throw new Error("expected a created admin");
    track(created.userId);
    const signedInId = await signInOk(freshEmail, freshPw1);
    if (signedInId !== created.userId) throw new Error("sign-in returned a different user id");
    await signInUnauthorized(freshEmail, `wrong-${freshPw1}`);

    // ── 2. no-op preserves sessions, timestamps and hash ─────────────
    step("repeat run preserves sessions, timestamps and hash");
    const before = (
      await client.query(
        `select (select count(*)::int from session where "userId" = u.id) as sessions,
                to_char(u."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') as updated_at,
                (select password from account where "userId" = u.id and "providerId" = 'credential') as hash
           from "user" u where u.id = $1`,
        [created.userId],
      )
    ).rows[0] as { sessions: number; updated_at: string; hash: string };
    if (before.sessions < 1) throw new Error("expected the sign-in session to exist");
    const again = await ensureAdminWithClient(client, freshEmail.toUpperCase(), freshPw1);
    if (again.status !== "unchanged") throw new Error("expected unchanged on the same password");
    if (again.userId !== created.userId) throw new Error("user id changed on a no-op run");
    const after = (
      await client.query(
        `select (select count(*)::int from session where "userId" = u.id) as sessions,
                to_char(u."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') as updated_at,
                (select password from account where "userId" = u.id and "providerId" = 'credential') as hash
           from "user" u where u.id = $1`,
        [created.userId],
      )
    ).rows[0] as { sessions: number; updated_at: string; hash: string };
    if (after.sessions !== before.sessions) throw new Error("no-op run must not touch sessions");
    if (after.updated_at !== before.updated_at) throw new Error("no-op run must not touch updatedAt");
    if (after.hash !== before.hash) throw new Error("no-op run must not rewrite the hash");

    // ── 3. rotation revokes sessions and kills the old password ──────
    step("rotate the password");
    const freshPw2 = `fresh-pw-2-${stamp}-yyyy`;
    const rotated = await ensureAdminWithClient(client, freshEmail, freshPw2);
    if (rotated.status !== "rotated") throw new Error("expected a rotated admin");
    const leftovers = (
      await client.query(`select count(*)::int as n from session where "userId" = $1`, [
        created.userId,
      ])
    ).rows[0] as { n: number };
    if (leftovers.n !== 0) throw new Error("rotation must drop every session");
    await signInUnauthorized(freshEmail, freshPw1);
    const rotatedId = await signInOk(freshEmail, freshPw2);
    if (rotatedId !== created.userId) throw new Error("sign-in after rotation hit another user");

    // ── 4. mixed-case OAuth-only account: link, normalize, sign in ────
    step("link onto a mixed-case OAuth-only account");
    const oauthMixed = `Existing.Admin-${stamp}@Example.test`;
    const oauthLower = oauthMixed.toLowerCase();
    const oauthId = `oauth-${stamp}`;
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", plan, handle)
       values ($1, 'OAuth Owner', $2, true, now(), now(), 'pro', $3)`,
      [oauthId, oauthMixed, `keepme-${stamp}`],
    );
    track(oauthId);
    await client.query(
      `insert into account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
       values ($1, $2, 'github', $3, now(), now())`,
      [`gh-${stamp}`, `github-${stamp}`, oauthId],
    );
    const oauthPw = `oauth-pw-1-${stamp}-zzzz`;
    const linked = await ensureAdminWithClient(client, oauthLower, oauthPw);
    if (linked.status !== "linked") throw new Error("expected a linked admin");
    if (linked.userId !== oauthId) throw new Error("linking must preserve the user id");
    const stored = (
      await client.query<{ email: string; handle: string | null; plan: string }>(
        `select email, handle, plan from "user" where id = $1`,
        [oauthId],
      )
    ).rows[0];
    if (stored.email !== oauthLower) {
      throw new Error("stored email was not normalized to lowercase");
    }
    if (stored.handle !== `keepme-${stamp}`) {
      throw new Error("existing handle was not preserved");
    }
    const ghStillThere = (
      await client.query(`select count(*)::int as n from account where "userId" = $1 and "providerId" = 'github'`, [
        oauthId,
      ])
    ).rows[0] as { n: number };
    if (ghStillThere.n !== 1) throw new Error("OAuth account row must survive linking");
    const oauthSignIn = await signInOk(oauthLower, oauthPw);
    if (oauthSignIn !== oauthId) throw new Error("sign-in after linking hit another user");
    await signInOk(oauthMixed.toUpperCase(), oauthPw);

    // ── 5. handle collision: the taken handle must not abort the boot ──
    step("colliding handle stays collision-free");
    const clashBase = `clash-${stamp}`;
    const holderId = `holder-${stamp}`;
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", plan, handle)
       values ($1, 'Holder', $2, true, now(), now(), 'free', $3)`,
      [holderId, `holder-${stamp}@example.test`, clashBase],
    );
    track(holderId);
    const clashEmail = `${clashBase}@example.test`;
    const clashPw = `clash-pw-1-${stamp}-qqqq`;
    const clashed = await ensureAdminWithClient(client, clashEmail, clashPw);
    if (clashed.userId === holderId) throw new Error("bootstrap reused another account");
    track(clashed.userId);
    if (!clashed.handle || clashed.handle === clashBase) {
      throw new Error("bootstrap must allocate a distinct handle on collision");
    }
    await signInOk(clashEmail, clashPw);

    // ── 6. ambiguous case-folded duplicates refuse ─────────────────────
    step("ambiguous duplicates refuse");
    const dupLower = `dup-${stamp}@example.test`;
    const dupA = `a-dup-${stamp}`;
    const dupB = `b-dup-${stamp}`;
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", plan)
       values ($1, 'Dup A', $2, true, now(), now(), 'free'), ($3, 'Dup B', $4, true, now(), now(), 'free')`,
      [dupA, dupLower, dupB, dupLower.toUpperCase()],
    );
    track(dupA);
    track(dupB);
    let refused = false;
    try {
      await ensureAdminWithClient(client, dupLower, `dup-pw-1-${stamp}-wwww`);
    } catch (err) {
      if (/multiple accounts match/i.test(err instanceof Error ? err.message : String(err))) {
        refused = true;
      } else {
        throw err;
      }
    }
    if (!refused) throw new Error("ambiguous duplicates must be refused, not merged");
    const dupCreds = (
      await client.query(`select count(*)::int as n from account where "userId" = any($1)`, [
        [dupA, dupB],
      ])
    ).rows[0] as { n: number };
    if (dupCreds.n !== 0) throw new Error("refused bootstrap must not write credentials");

    step("ok — cleaning up");
    console.log("✓ admin bootstrap integration passed");
  } finally {
    if (fixtureIds.length) {
      await client
        .query(`delete from "user" where id = any($1)`, [fixtureIds])
        .catch(() => {});
    }
    await client.end();
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(
    `\nadmin bootstrap integration FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
