import PgBoss from "pg-boss";
import { env } from "@/lib/env";

/**
 * Job queue. Lives in Postgres via pg-boss — one less service to run.
 * SVOD stage 7: only svod-index remains. Learning queues are retired.
 */

export const QUEUES = {
  /** SVOD section embeddings. NOT a learning queue: runs without a paid
   *  model key. pg-boss only wakes the worker; svod_embed_outbox is the
   *  source of truth. */
  svodIndex: "svod-index",
} as const;

/** Retired learning queues — kept for the migration that cancels them. */
export const LEARNING_QUEUES: string[] = [];

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const instance = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: "pgboss",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    });
    instance.on("error", (err) => console.error("[queue]", err));
    await instance.start();
    for (const name of Object.values(QUEUES)) {
      await instance.createQueue(name);
    }
    boss = instance;
    return instance;
  })();
  return starting;
}
