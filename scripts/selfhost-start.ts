/**
 * Self-host bootstrapper: wait for Postgres, migrate, bootstrap the admin.
 *
 * Used only by docker-compose.selfhost.yml, which runs it *before* Next:
 * `sh -c "node dist/selfhost-start.mjs && exec <next>"`. A nonzero exit here
 * stops the container before Next ever serves, and `exec` hands Docker's
 * signals straight to the Next process. Normal `npm run start` / `next
 * start`, manual `npm run db:migrate` and the prod compose keep working
 * untouched — none of them run this file.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrations } from "../src/lib/migrate-runner";
import { withCredLock, credKeyForUser } from "../src/lib/cred-lock";
import {
  ensureAdminWithClient,
  validateAdminEnv,
} from "../src/lib/admin-bootstrap";

const here = dirname(fileURLToPath(import.meta.url));
// Bundled: dist/selfhost-start.mjs → ../src/db/migrations.
// tsx: scripts/selfhost-start.ts → ../src/db/migrations. Same relative hop.
const migrationsDir = join(here, "..", "src", "db", "migrations");

const EXAMPLE_SECRETS = new Set([
  "change-me-openssl-rand-hex-32",
  "build-time-placeholder-not-a-secret",
  "example",
  "test",
  "secret",
  "password",
]);

function fail(msg: string): never {
  console.error(`\n[selfhost-start] ${msg}`);
  process.exit(1);
}

function checkEnv(): { databaseUrl: string; adminEmail: string; adminPassword: string } {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    fail("DATABASE_URL is missing — the compose file sets it from POSTGRES_PASSWORD; check .env (see .env.selfhost.example)");
  }

  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (
    !secret ||
    secret.length < 32 ||
    EXAMPLE_SECRETS.has(secret) ||
    /example|change-me|placeholder/i.test(secret)
  ) {
    fail(
      "BETTER_AUTH_SECRET is missing or looks like an example — generate a stable one with `openssl rand -hex 32` and set it in .env (see .env.selfhost.example). The app will not start with a placeholder secret.",
    );
  }

  let admin: { email: string; password: string };
  try {
    admin = validateAdminEnv(process.env.MOZG_ADMIN_EMAIL, process.env.MOZG_ADMIN_PASSWORD);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  return { databaseUrl, adminEmail: admin!.email, adminPassword: admin!.password };
}

async function waitForDb(databaseUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let attempt = 0;
  for (;;) {
    attempt++;
    // Bounded per attempt as well as in total: a hung SYN must not wedge
    // the boot past the deadline check below.
    const probe = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
    });
    try {
      await probe.connect();
      await probe.query("select 1");
      await probe.end().catch(() => {});
      if (attempt > 1) console.log(`[selfhost-start] postgres is up after ${attempt} tries`);
      return;
    } catch (err) {
      await probe.end().catch(() => {});
      if (Date.now() > deadline) {
        const reason = err instanceof Error ? err.message : String(err);
        fail(`postgres is not reachable at DATABASE_URL after 90s: ${reason}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  const { databaseUrl, adminEmail, adminPassword } = checkEnv();

  await waitForDb(databaseUrl);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    // Never the URL itself — DATABASE_URL carries the password.
    fail(
      `could not connect to Postgres: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    let applied: string[] = [];
    try {
      ({ applied } = await applyMigrations(client, migrationsDir));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      fail(`migration failed, not serving: ${reason}`);
    }
    console.log(
      applied.length
        ? `[selfhost-start] migrations applied: ${applied.join(", ")}`
        : "[selfhost-start] migrations up to date",
    );

    try {
      // Serialized with sign-in and admin resets for this account (same
      // per-user advisory lock the auth route and /admin/users hold), so a
      // rotation at startup cannot interleave with a verify+insert-session.
      const lookup = await client.query<{ id: string }>(
        `select id from "user" where lower(email) = lower($1) limit 2`,
        [adminEmail],
      );
      const key =
        lookup.rows.length === 1
          ? credKeyForUser(lookup.rows[0].id)
          : credKeyForUser(`bootstrap:${adminEmail.toLowerCase()}`);
      const res = await withCredLock(key, () =>
        ensureAdminWithClient(client, adminEmail, adminPassword),
      );
      if (res.status === "created") console.log(`[selfhost-start] admin created for ${adminEmail}`);
      else if (res.status === "linked")
        console.log(`[selfhost-start] admin password linked for ${adminEmail}`);
      else if (res.status === "rotated")
        console.log(`[selfhost-start] admin password rotated for ${adminEmail}`);
      else console.log(`[selfhost-start] admin up to date for ${adminEmail}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // validateAdminEnv and bootstrap never include the password/hash.
      fail(`admin bootstrap failed for ${adminEmail}, not serving: ${reason}`);
    }
  } finally {
    await client.end();
  }

  // Done. The compose command execs Next from here — no embedding wait, the
  // app serves (degraded search) while weights download.
  console.log("[selfhost-start] ready");
}

main().catch((err) => {
  console.error(`[selfhost-start] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
