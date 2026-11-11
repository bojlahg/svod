import { getBoss, QUEUES, LEARNING_QUEUES, holdLearningQueues, scheduleMaintenance, MAINTENANCE_CRON, CONSOLIDATE_CRON, scheduleConsolidation, CONTRADICT_CRON, scheduleContradictions, scheduleDigest, scheduleMozgpay, enqueueIngest, enqueueCrawl, enqueueGeneration } from "@/worker/queue";
import { isCrawlRoot } from "@/lib/sources";
import { runDigest } from "@/worker/digest";
import { runMozgpayWatch } from "@/worker/mozgpay";
import { compileLesson } from "@/worker/lesson";
import { withOwnerKey } from "@/lib/byok";
import { maybeOne } from "@/db";

/** BYOK: run a per-brain job on its owner's key when they set one. */
async function withBrainOwner<T>(brainId: string, fn: () => Promise<T>): Promise<T> {
  const row = await maybeOne<{ owner_id: string }>(
    `select owner_id from brains where id = $1`, [brainId],
  );
  return row ? withOwnerKey(row.owner_id, fn) : fn();
}

async function withSourceOwner<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const row = await maybeOne<{ owner_id: string }>(
    `select b.owner_id from sources s join brains b on b.id = s.brain_id where s.id = $1`,
    [sourceId],
  );
  return row ? withOwnerKey(row.owner_id, fn) : fn();
}

import { query } from "@/db";
import { reportError, reportOutOfCreditOnce } from "@/lib/errors";
import {
  BudgetPausedError,
  ingestSource,
  isOutOfCredit,
  RateLimitedError,
  SourceBusyError,
} from "@/worker/ingest";
import { EmptyPageError } from "@/lib/page";
import { crawlSite } from "@/worker/crawl";
import { runExam } from "@/worker/exam";
import { compileSummaries } from "@/worker/summary";
import { runMaintenance, refreshBrain } from "@/worker/maintenance";
import { runGeneration, releaseRest } from "@/worker/generate";
import { failGeneration } from "@/lib/generate";
import { runConsolidation } from "@/worker/consolidate";
import { runContradictions } from "@/worker/contradict";
import { embedHealthy } from "@/lib/embed";
import { env } from "@/lib/env";

/**
 * Background worker. Run alongside the web app:
 *
 *   npm run worker
 */

async function main() {
  if (!(await embedHealthy())) {
    console.warn(
      `[worker] embedding service not reachable at ${env.EMBED_URL} — ` +
        "ingest will fail until it is up (services/embed/run.sh)",
    );
  }

  const boss = await getBoss();
  if (env.LEARNING_OFF) holdLearningQueues(boss);

  // Anything left mid-flight by the last shutdown. A deploy restarts the
  // worker whenever it likes, and a source interrupted between "processing"
  // and "ready" was simply abandoned — it stayed processing forever, counted
  // as stuck by the health check, and nothing ever picked it up again.
  //
  // No age threshold on purpose: during a deploy overlap the old worker may
  // still hold a source this sweep requeues, and that is now safe — the
  // requeued job bounces off the advisory lock in ingestSource and pg-boss
  // retries it once the real run has finished.
  const orphans = await query<{ id: string; kind: string; name: string | null }>(
    `update sources set status = 'queued', processing_at = null
      where status = 'processing' returning id, kind, coalesce(original_name, url) as name`,
  );
  for (const o of orphans) {
    // A site source belongs to the crawl queue — requeueing it as an ingest
    // would fail it with "unknown kind" instead of resuming the discovery.
    await (isCrawlRoot(o.kind) ? enqueueCrawl(o.id) : enqueueIngest(o.id));
  }
  if (orphans.length) {
    console.log(
      `[worker] requeued ${orphans.length} source(s) interrupted by the last stop:`,
      orphans.map((o) => o.name ?? o.id).join(", "),
    );
  }

  // Paid assets nobody is coming back for.
  //
  // A generation row is written inside the transaction that takes the money,
  // and only then queued. If that queue call is lost — a hiccup, a worker that
  // died between the two — the row sits at "queued" forever: paid for, never
  // drawn, and invisible because nothing was watching. A pack makes it worse,
  // because the set is released by the anchor finishing, so a worker that
  // stops in that gap strands twelve assets instead of one.
  //
  // A set still waiting on its own anchor is deliberately left alone: those
  // assets are meant to be drawn *against* the anchor's picture, and releasing
  // them early would trade the consistency the studio paid for against a few
  // minutes.
  // A deploy that lands mid-generation leaves the row it was working on stuck
  // at "running" forever: the pg-boss job died with the container and this
  // queue has no retries, by design — a retry there would be a second paid
  // call for a buyer charged once. So the row is put back on the queue
  // instead, which reaches the same worker through the front door.
  //
  // Fifteen minutes, not "any running row": the client gives up after four,
  // and autoscale can have a second worker legitimately mid-job. Anything
  // older than that is not being worked on by anybody.
  const abandoned = await query<{ id: string }>(
    `update generations set status = 'queued'
      where status = 'running' and created_at < now() - interval '15 minutes'
      returning id`,
  );
  for (const row of abandoned) await enqueueGeneration(row.id);
  if (abandoned.length) {
    console.log(`[worker] requeued ${abandoned.length} generation(s) a restart interrupted`);
  }

  const stranded = await query<{ id: string }>(
    `select g.id
       from generations g
       left join asset_packs p on p.id = g.pack_id
       left join generations a on a.pack_id = g.pack_id and a.is_anchor
      where g.status = 'queued'
        and (g.pack_id is null
             or g.is_anchor
             or p.reference_key is not null
             or a.status in ('done', 'failed'))`,
  );
  for (const row of stranded) await enqueueGeneration(row.id);
  if (stranded.length) {
    console.log(`[worker] requeued ${stranded.length} paid generation(s) nobody had queued`);
  }

  await boss.work(
    QUEUES.ingest,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      const { sourceId } = job.data as { sourceId: string };
      const started = Date.now();
      try {
        const result = await withSourceOwner(sourceId, () => ingestSource(sourceId));
        console.log(
          `[ingest] ${sourceId} ${result.status} notes=${result.notes} ` +
            `${Date.now() - started}ms` +
            (result.findings?.length ? ` findings=${result.findings.length}` : ""),
        );
      } catch (err) {
        // pg-boss swallows the throw into its retry bookkeeping, so a failure
        // would otherwise leave no trace in the log at all — the worst possible
        // shape for an ops problem.
        // A spent budget is a decision the plan already made. The source row
        // carries the reason and maintenance requeues it when the window
        // rolls, so retrying now would only re-derive the same sentence three
        // more times. Swallowed on purpose: nothing here is broken.
        // Same shape as a budget pause: nothing is broken, the window is
        // just closed. Logged once, requeued by maintenance, no error row —
        // an operator paged for someone else's rate limiter learns nothing.
        if (err instanceof RateLimitedError) {
          console.log(`[ingest] ${sourceId} rate limited — will resume`);
          return;
        }
        if (err instanceof BudgetPausedError) {
          console.log(`[ingest] ${sourceId} paused — ${err.message}`);
          return;
        }
        // A stub page is not an incident. ingestSource has already failed the
        // source with the reason on the row, which is where its owner looks;
        // retrying cannot make a twenty-nine-character include directive grow,
        // and each retry used to write another identical row into the operator's
        // triage list. Swallowed like the two above: nothing here is broken.
        if (err instanceof EmptyPageError) {
          console.log(`[ingest] ${sourceId} nothing to read — ${err.message}`);
          return;
        }
        if (err instanceof SourceBusyError) {
          console.log(`[ingest] ${sourceId} ${err.message}`);
        } else {
          reportError("worker", "ingest", err, {
            detail: `source ${sourceId}, after ${Date.now() - started}ms`,
          });
        }
        throw err;
      }
    },
  );

  // One image, one payment, one artist paid. retryLimit is 0 on this queue —
  // a retry would be a second call to a paid model for a buyer who was charged
  // once, so a failure refunds instead.
  await boss.work(
    QUEUES.generate,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      const { generationId } = job.data as { generationId: string };
      const started = Date.now();
      try {
        await runGeneration(generationId);
        console.log(`[generate] ${generationId} done ${Date.now() - started}ms`);
      } catch (err) {
        // The refund is the important half and must happen even when the
        // reporting fails, so it goes first.
        const reason = err instanceof Error ? err.message : String(err);
        await failGeneration(generationId, reason).catch((e) =>
          reportError("worker", "generate-refund", e, { detail: generationId }),
        );
        // An anchor that died still owes the studio the rest of its set. They
        // will match each other less closely than they should have — there is
        // no reference now — but they were paid for, and silence is the one
        // outcome that takes money and gives nothing.
        const anchor = await maybeOne<{ pack_id: string }>(
          `select pack_id from generations where id = $1 and is_anchor and pack_id is not null`,
          [generationId],
        ).catch(() => null);
        if (anchor) await releaseRest(anchor.pack_id).catch(() => {});
        reportError("worker", "generate", err, { detail: `generation ${generationId}` });
      }
    },
  );

  await boss.work(
    QUEUES.crawl,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      const { sourceId } = job.data as { sourceId: string };
      const started = Date.now();
      try {
        const result = await crawlSite(sourceId);
        console.log(
          `[crawl] ${sourceId} queued=${result.queued} skipped=${result.skipped} ` +
            `via=${result.via} ${Date.now() - started}ms`,
        );
      } catch (err) {
        if (err instanceof SourceBusyError) {
          console.log(`[crawl] ${sourceId} ${err.message}`);
        } else {
          console.error(
            `[crawl] ${sourceId} FAILED after ${Date.now() - started}ms:`,
            err instanceof Error ? err.message : err,
          );
        }
        throw err;
      }
    },
  );

  await boss.work(
    QUEUES.exam,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
      const { brainId, mini, force } = job.data as {
        brainId: string;
        mini?: boolean;
        force?: boolean;
      };
      const started = Date.now();
      try {
        const result = await withBrainOwner(brainId, () => runExam(brainId, { mini, force }));
        console.log(
          result
            ? `[exam] ${brainId} ${result.score}% (${result.passed}/${result.total}` +
                `${result.carried ? `, ${result.carried} carried` : ""}` +
                `${result.negativeTotal ? `, anti-bluff ${result.negativePassed}/${result.negativeTotal}` : ""}) ` +
                `${result.costCents.toFixed(1)}¢ ${Date.now() - started}ms`
            // Null is every skip, not one of them: the cooldown, the mini
            // rate limit and the plan's sitting budget all return it, and
            // runExam has already said which. Naming one reason here printed
            // "brain has no goal" under a brain whose goal was right there.
            : `[exam] ${brainId} skipped`,
        );
      } catch (err) {
        // The platform key having no money left is not a fault of this brain,
        // and it is true of every brain at once — 31 identical rows in three
        // days, one per sitting that started after the balance ran out. There
        // is nothing to retry into and nothing to debug, so it is logged once
        // and the sitting is dropped; the next maintenance pass re-queues it
        // like any other stale brain once the key is topped up.
        if (isOutOfCredit(err)) {
          console.log(`[exam] ${brainId} dropped — provider credit exhausted`);
          await reportOutOfCreditOnce("worker", err, { brainId });
          return;
        }
        reportError("worker", "exam", err, {
          brainId,
          detail: `after ${Date.now() - started}ms`,
        });
        throw err;
      }
    },
  );

  await boss.work(
    QUEUES.maintenance,
    { batchSize: 1, pollingIntervalSeconds: 30 },
    async () => {
      const started = Date.now();
      try {
        const { refresh, examined, probes, recrawled, resumed, gapChecks, gapsClosed, abandoned } =
          await runMaintenance();
        console.log(
          `[maintenance] due=${refresh.due} checked=${refresh.checked} ` +
            `unchanged=${refresh.unchanged} ` +
            `changed=${refresh.changed} failed=${refresh.failed} reexam=${examined} ` +
            `probes=${probes} ` +
            `recrawl=${recrawled} resumed=${resumed} gapchecks=${gapChecks} ` +
            `gapsclosed=${gapsClosed} ` +
            `abandoned=${abandoned} ${Date.now() - started}ms`,
        );
      } catch (err) {
        console.error(
          `[maintenance] FAILED after ${Date.now() - started}ms:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      }
    },
  );

  // On-demand brain refresh (brain_refresh / "/mozg:update"). Its own queue so
  // one person updating a five-hundred-page brain does not sit in front of the
  // scheduled maintenance pass everyone else depends on.
  await boss.work(
    QUEUES.refresh,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
      const { brainId } = job.data as { brainId: string };
      const started = Date.now();
      try {
        const r = await refreshBrain(brainId);
        console.log(
          `[refresh] ${brainId} checked=${r.checked} changed=${r.changed} ` +
            `failed=${r.failed} sites=${r.sitesRecrawled} ${Date.now() - started}ms`,
        );
      } catch (err) {
        console.error(
          `[refresh] ${brainId} FAILED after ${Date.now() - started}ms:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      }
    },
  );

  await scheduleMaintenance();

  await boss.work(
    QUEUES.consolidate,
    { batchSize: 1, pollingIntervalSeconds: 30 },
    async () => {
      const started = Date.now();
      try {
        const report = await runConsolidation();
        console.log(
          `[consolidate] brains=${report.brains} clusters=${report.clusters} ` +
            `merged=${report.merged} superseded=${report.superseded} ` +
            `skipped=${report.skipped} ${report.costCents.toFixed(1)}¢ ` +
            `${Date.now() - started}ms`,
        );
      } catch (err) {
        console.error(
          `[consolidate] FAILED after ${Date.now() - started}ms:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      }
    },
  );

  await scheduleConsolidation();

  await boss.work(
    QUEUES.contradict,
    { batchSize: 1, pollingIntervalSeconds: 30 },
    async () => {
      const started = Date.now();
      try {
        const report = await runContradictions();
        console.log(
          `[contradict] packs=${report.packs} candidates=${report.candidates} ` +
            `judged=${report.judged} found=${report.found} ` +
            `retracted=${report.retracted} ` +
            `${report.costCents.toFixed(1)}¢ ${Date.now() - started}ms`,
        );
      } catch (err) {
        reportError("worker", "contradict", err, {
          detail: `after ${Date.now() - started}ms`,
        });
        throw err;
      }
    },
  );

  await scheduleContradictions();

  await boss.work(QUEUES.digest, { batchSize: 1, pollingIntervalSeconds: 60 }, async () => {
    const sent = await runDigest();
    console.log(`[digest] sent ${sent} weekly letter(s)`);
  });
  await scheduleDigest();

  await boss.work(QUEUES.lesson, { batchSize: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    const { brainId, category } = job.data as { brainId: string; category: string };
    const outcome = await withBrainOwner(brainId, () => compileLesson(brainId, category));
    console.log(`[lesson] ${brainId} "${category}" ${outcome}`);
  });

  await boss.work(QUEUES.summary, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
    const { brainId } = job.data as { brainId: string };
    const started = Date.now();
    try {
      const r = await withBrainOwner(brainId, () => compileSummaries(brainId));
      console.log(
        `[summary] ${brainId} compiled=${r.compiled} current=${r.current} ` +
          `pruned=${r.pruned} ${r.costCents.toFixed(1)}¢ ${Date.now() - started}ms`,
      );
    } catch (err) {
      console.error(
        `[summary] ${brainId} FAILED after ${Date.now() - started}ms:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  });

  await boss.work(QUEUES.mozgpay, { batchSize: 1, pollingIntervalSeconds: 15 }, async () => {
    const r = await runMozgpayWatch();
    if (r.matched || r.expired || r.unmatched) {
      console.log(
        `[mozgpay] matched=${r.matched} expired=${r.expired} ` +
          `unmatched=${r.unmatched} seen=${r.seen}`,
      );
    }
  });
  await scheduleMozgpay();

  // SVOD stage 5 section embeddings. pg-boss only wakes us; the outbox table
  // is the source of truth, so the start-up sweep below plus the short
  // periodic sweep recover a lost wake-up without a live boss. This queue is
  // deliberately NOT in LEARNING_QUEUES: indexing runs without a paid key.
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

  // The schedule* calls above just (re)registered the crons of the held queues;
  // drop them so ticks do not pile up jobs nobody consumes. Boot without
  // LEARNING_OFF registers them again.
  if (env.LEARNING_OFF) {
    for (const q of LEARNING_QUEUES) await boss.unschedule(q).catch(() => {});
    console.log(`[worker] LEARNING_OFF — not consuming: ${LEARNING_QUEUES.join(", ")}`);
  }

  console.log(
    `[worker] up — queues: ${Object.values(QUEUES).join(", ")} ` +
      `(one job at a time per queue, maintenance ${MAINTENANCE_CRON} UTC, ` +
      `consolidation ${env.CONSOLIDATE_ENABLED ? `${CONSOLIDATE_CRON} UTC` : "off"}, ` +
      `contradictions ${env.CONTRADICT_ENABLED ? `${CONTRADICT_CRON} UTC` : "off"})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`\n[worker] ${signal}, draining…`);
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The stranger failures — a rejection nobody awaited, a throw outside every
  // catch — used to exist only in a container log the next deploy erases.
  process.on("unhandledRejection", (err) => reportError("worker", "unhandled", err));
  process.on("uncaughtException", (err) => reportError("worker", "unhandled", err));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
