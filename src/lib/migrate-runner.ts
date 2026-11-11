import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";

/**
 * Serialized SQL migration runner.
 *
 * Applies src/db/migrations/*.sql in filename order, once each, each file in
 * its own transaction. Parallel app startups and manual `npm run db:migrate`
 * runs serialize on a session-level advisory lock so two processes never apply
 * the same file twice or interleave DDL.
 *
 * No baseline, no drop/recreate here — `--reset` lives only in the manual
 * scripts/migrate.ts path. Errors carry the failing filename for the container
 * log and must make the caller exit nonzero before serving.
 */

export const MIGRATIONS_LOCK_ID = 810007;

export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  return files;
}

export async function applyMigrations(
  client: Client,
  migrationsDir: string,
  options?: { reset?: boolean },
): Promise<{ applied: string[] }> {
  // Serialize parallel startups / manual runs (including --reset, which must
  // not interleave with another applier). Session-level on purpose: the
  // per-file BEGIN/COMMIT below would release a transaction-scoped lock after
  // the first file. The self-host startup path never passes `reset`.
  await client.query(`select pg_advisory_lock(${MIGRATIONS_LOCK_ID}::bigint)`);

  try {
    if (options?.reset) {
      await client.query("drop schema public cascade; create schema public;");
    }

    await client.query(`
      create table if not exists _migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>("select name from _migrations")).rows.map(
        (r) => r.name,
      ),
    );

    const files = await listMigrationFiles(migrationsDir);
    const done: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into _migrations (name) values ($1)", [file]);
        await client.query("commit");
        done.push(file);
      } catch (err) {
        try {
          await client.query("rollback");
        } catch {
          // The original error is what matters; a rollback failure only
          // matters insofar as the migration failed.
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`migration ${file} failed: ${reason}`);
      }
    }

    return { applied: done };
  } finally {
    try {
      await client.query(`select pg_advisory_unlock(${MIGRATIONS_LOCK_ID}::bigint)`);
    } catch {
      // Unlock failure after a successful run must not fail the boot; after a
      // failed run the original error is already propagating.
    }
  }
}
