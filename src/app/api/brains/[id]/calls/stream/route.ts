import { query } from "@/db";
import { canRead } from "@/lib/access";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Live tool-call feed for one brain, over SSE.
 *
 * lazy: polls the calls table every 2s rather than using LISTEN/NOTIFY. NOTIFY
 * would need a dedicated connection held open per viewer plus a trigger; the
 * poll is one indexed query against a table we already write to. Swap it if
 * viewer counts ever make the polling visible in the database load.
 *
 * The tick re-schedules itself with setTimeout only after it finishes — an
 * interval would stack overlapping queries on a slow database and let their
 * cursor writes race.
 */

const POLL_MS = 2000;
const MAX_LIFETIME_MS = 10 * 60 * 1000;

interface Row {
  id: string;
  tool: string;
  query: string | null;
  results: number | null;
  latency_ms: number | null;
  ok: boolean;
  /** Text, not Date — the client formats it without a locale so that server
   *  and stream render byte-identically. */
  created_at: string;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await requireUser(req).catch(() => null);
  // Unknown and ungranted are the same 404 — the status must not say whether
  // the base exists.
  if (!user || !(await canRead(id, user.id))) {
    return new Response("not found", { status: 404 });
  }

  // Start from the newest row so a viewer sees only calls made while watching.
  const seed = await query<{ id: string }>(
    `select id::text from calls where brain_id = $1 order by id desc limit 1`,
    [id],
  );
  let cursor = seed[0]?.id ?? "0";

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      send("ready", { since: cursor });

      let timer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const tick = async () => {
        if (stopped) return;
        if (Date.now() - started > MAX_LIFETIME_MS) {
          send("bye", { reason: "timeout" });
          stop();
          return;
        }

        try {
          const rows = await query<Row>(
            `select id::text, tool, query, results, latency_ms, ok,
                    to_char(created_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
               from calls where brain_id = $1 and id > $2::bigint
              order by id asc limit 50`,
            [id, cursor],
          );

          // The client may have hung up while the query ran — the controller
          // is closed then, and writing to it would throw.
          if (stopped) return;

          for (const row of rows) {
            cursor = row.id;
            send("call", row);
          }

          // Keeps proxies from closing an idle connection.
          if (!rows.length) controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // A transient database error should not kill the stream; the next
          // tick retries and the cursor has not moved.
        }

        if (!stopped) timer = setTimeout(tick, POLL_MS);
      };

      timer = setTimeout(tick, POLL_MS);
      req.signal.addEventListener("abort", stop);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
