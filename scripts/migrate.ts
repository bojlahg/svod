/**
 * SQL migration runner. Applies src/db/migrations/*.sql in filename order,
 * once each, inside a transaction.
 *
 *   npm run db:migrate          apply pending
 *   npm run db:reset            drop everything, then apply all
 *
 * 0000_auth.sql carries better-auth's own tables. They used to come from its
 * CLI, which does nothing inside a container — see the note in that file.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrations } from "../src/lib/migrate-runner";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "src", "db", "migrations");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://mozg:mozg@localhost:5433/mozg";

async function main() {
  const reset = process.argv.includes("--reset");
  const client = new Client({ connectionString: DATABASE_URL });

  try {
    // Inside the try so a refused connection is reported with context below
    // instead of escaping as an unhandled rejection. Never print
    // DATABASE_URL itself — it carries the password.
    await client.connect();

    if (reset) console.log("⚠  dropping schema public");

    // --reset runs under the same advisory lock as a plain apply (inside
    // applyMigrations) so two manuals can never interleave DDL.
    const { applied } = await applyMigrations(client, migrationsDir, { reset });
    for (const file of applied) console.log(`→ ${file} ok`);

    console.log(
      applied.length ? `\n✓ applied ${applied.length} migration(s)` : "\n✓ up to date",
    );
  } catch (err) {
    // Context first: which file broke (or that the connection did), then the
    // underlying reason. Never the connection string.
    console.error(
      `\nmigration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(() => {
  process.exit(1);
});
