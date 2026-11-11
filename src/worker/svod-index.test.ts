import "@/lib/test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEARNING_QUEUES, QUEUES } from "./queue";
import { sweepSvodIndex } from "./svod-index";

/**
 * SVOD stage 5 worker half: queue membership, batch ceiling, stale-hash
 * discipline and outbox durability. Fake embed transport; no weights/GPU.
 */

test("svod-index is a real queue but never a learning queue", () => {
  assert.equal(QUEUES.svodIndex, "svod-index");
  assert.ok(!LEARNING_QUEUES.includes(QUEUES.svodIndex));
});

test("claim SQL uses SKIP LOCKED and the worker re-reads between batches", () => {
  const src = readFileSync(join(__dirname, "svod-index.ts"), "utf8");
  assert.match(src, /for update .* skip locked/i);
  assert.match(src, /not_before <= now\(\)/);
  assert.match(src, /embed_state = 'pending'/);
});

test("a lock older than 2 minutes is free again, a fresh lock is not", () => {
  const src = readFileSync(join(__dirname, "svod-index.ts"), "utf8");
  assert.match(src, /o\.locked_at is null or o\.locked_at < now\(\) - interval '2 minutes'/);
});

test("passage batches stay at most 8 texts (claim and embed both capped)", async () => {
  let batches = 0;
  const mk = (k: number) => ({
    outboxId: `o${k}`,
    chunkId: `c${k}`,
    brainId: "11111111-1111-4111-8111-111111111132",
    noteId: "11111111-1111-4111-8111-111111111133",
    inputHash: `h${k}`,
    attempts: 0,
    content: `section ${k}`,
  });
  const pool = Array.from({ length: 20 }, (_, i) => mk(i));
  await sweepSvodIndex({
    claimFn: async (limit: number) => {
      assert.ok(limit <= 8);
      batches += 1;
      return pool.splice(0, Math.min(limit, 8));
    },
    embedFn: async (texts: string[]) => {
      assert.ok(texts.length <= 8, `batch ${texts.length} > 8`);
      return { vectors: texts.map(() => [0.5, 0.5]), fingerprintId: "fp-test" };
    },
  });
  assert.ok(batches >= 3, `expected several 8-capped batches, got ${batches}`);
});

test("late vector with a stale hash never overwrites the new revision", () => {
  const src = readFileSync(join(__dirname, "svod-index.ts"), "utf8");
  // One statement writes the vector and conditionally drops the queue row.
  assert.match(src, /with upd as \(/);
  assert.match(src, /update chunks/);
  assert.match(src, /embed_fingerprint = \$2/);
  assert.match(src, /embed_state = 'ready'/);
  assert.match(src, /embed_error = null/);
  assert.match(src, /and input_hash = \$4/);
  assert.match(src, /and brain_id = \$5/);
  assert.match(src, /is distinct from/);
  assert.match(src, /'applied'/);
  assert.match(src, /'already'/);
  assert.match(src, /'dropped-inactive'/);
  assert.match(src, /'stale'/);
});

test("error path parks after 5 attempts but keeps the outbox for refresh", () => {
  const src = readFileSync(join(__dirname, "svod-index.ts"), "utf8");
  assert.match(src, /SVOD_INDEX_MAX_ATTEMPTS = 5/);
  assert.match(src, /embed_state = 'error'/);
  assert.match(src, /svod_embed_outbox/);
});
