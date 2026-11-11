import "@/lib/test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import type PgBoss from "pg-boss";
import { holdLearningQueues, LEARNING_QUEUES, QUEUES } from "./queue";

/**
 * LEARNING_OFF is the one thing standing between a restarted worker and 54
 * queued ingest jobs billed to the platform key, so what it must NOT hold
 * matters as much as what it must: payments and paid images keep running.
 */
test("holdLearningQueues skips every learning queue and nothing else", async () => {
  const registered: string[] = [];
  const boss = { work: async (name: string) => (registered.push(name), name) } as unknown as PgBoss;
  holdLearningQueues(boss);

  for (const name of Object.values(QUEUES)) {
    await (boss.work as unknown as (n: string) => Promise<string>)(name);
  }

  assert.deepEqual(
    registered.sort(),
    Object.values(QUEUES).filter((q) => !LEARNING_QUEUES.includes(q)).sort(),
  );
  // Stage 5 svod-index is not a learning queue: it runs without a paid key.
  assert.ok(!LEARNING_QUEUES.includes(QUEUES.svodIndex), "svod-index must not be held");
  assert.deepEqual(
    registered.sort(),
    [QUEUES.digest, QUEUES.generate, QUEUES.mozgpay, QUEUES.svodIndex].sort(),
  );
});
