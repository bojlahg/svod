import { getBoss, QUEUES } from "@/worker/queue";
import { reportError } from "@/lib/errors";

/**
 * Background worker. SVOD stage 7: private local base.
 * Only the Svod section index runs here.
 */

async function main() {
  const boss = await getBoss();

  // SVOD section embeddings. pg-boss only wakes us; the outbox table
  // is the source of truth, so the start-up sweep plus the short
  // periodic sweep recover a lost wake-up without a live boss. This queue is
  // deliberately NOT in learning queues: indexing runs without a paid key.
  const { sweepSvodIndex } = await import("@/worker/svod-index");
  const sweepOnce = async (why: string) => {
    try {
      const r = await sweepSvodIndex();
      if (r.batches || r.embedded || r.errors) {
        console.log(
          `[svod-index] ${why} batches=${r.batches} embedded=${r.embedded} ` +
            `errors=${r.errors}${r.skipped ? ` skipped=${r.skipped}` : ""}`,
        );
      }
    } catch (err) {
      console.error(
        `[svod-index] ${why} FAILED:`,
        err instanceof Error ? err.message : err,
      );
    }
  };
  await boss.work(
    QUEUES.svodIndex,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async () => {
      await sweepOnce("wake");
    },
  );
  // Start-up sweep: picks up rows queued while the worker was down and rows
  // whose wake-up send failed after the outbox commit.
  await sweepOnce("boot");
  const svodTimer = setInterval(() => void sweepOnce("tick"), 10_000);
  // A dangling interval keeps `node --test` (which imports the worker only
  // for its queue names) from exiting; unref so tests stay fast.
  (svodTimer as unknown as { unref?: () => void }).unref?.();

  console.log(`[worker] up — queue: ${QUEUES.svodIndex} (svod-index only)`);

  const shutdown = async (signal: string) => {
    console.log(`\n[worker] ${signal}, draining…`);
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => reportError("worker", "unhandled", err));
  process.on("uncaughtException", (err) => reportError("worker", "unhandled", err));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
