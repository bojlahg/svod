import { query } from "@/db";
import { embedHealthy } from "@/lib/embed";

/**
 * Is anything actually broken — the whole answer, in one place.
 *
 * /api/health had three of these checks and the admin console had five more,
 * which meant "is mozg up" had two different answers depending on who asked.
 * One function now, two readers: the JSON probe uptime monitors poll, and the
 * public page a person opens when something feels slow.
 *
 * Everything here is either a live ping (database, embedder) or a count over
 * rows the product already writes. Nothing calls a paid model to find out
 * whether paid models work: the last day of extractions already said so, and a
 * status page that bills per refresh is its own outage.
 */

export type State = "ok" | "degraded" | "down";

export interface Service {
  key: string;
  label: string;
  /** What this lane does, for someone who does not know our architecture. */
  blurb: string;
  state: State;
  /** The number behind the light. Always shown — a bare green dot is a claim. */
  detail: string;
}

export interface SystemStatus {
  state: State;
  services: Service[];
  /** Kept for /api/health's existing shape. */
  queue: { pending: number; stuck: number } | null;
}

/** The worst light on the board is the board's light. */
function worst(states: State[]): State {
  return states.includes("down") ? "down" : states.includes("degraded") ? "degraded" : "ok";
}

/**
 * Fifteen seconds of memory, and it is load-bearing.
 *
 * The footer's health dot renders on every page, which turns "one status page"
 * into a probe per pageview — and embedHealthy() waits up to fifteen seconds
 * twice before giving up. Without this, a busy embedder would have every
 * visitor holding a request open while we asked it again whether it was alive.
 * The window is short enough that a real outage still surfaces inside one
 * refresh of /status.
 *
 * In-process on purpose: each server instance keeps its own, which is correct
 * — an instance that cannot reach the database should say so about itself.
 */
let cached: { at: number; value: SystemStatus } | null = null;
let inflight: Promise<SystemStatus> | null = null;
const TTL_MS = 15_000;

export async function systemStatus(): Promise<SystemStatus> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  // A cold cache under a burst would otherwise start one full check per
  // waiting request — they share the first one instead.
  if (inflight) return inflight;

  inflight = check()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function check(): Promise<SystemStatus> {
  const dbOk = await query("select 1").then(
    () => true,
    () => false,
  );
  const embedOk = await embedHealthy();

  const services: Service[] = [
    {
      key: "web",
      label: "Website",
      blurb: "svod, and every base page.",
      state: "ok",
      detail: "answering — you are reading it",
    },
    {
      key: "database",
      label: "Database",
      blurb: "Where brains, notes and balances live.",
      state: dbOk ? "ok" : "down",
      detail: dbOk ? "answering" : "not answering",
    },
    {
      key: "embeddings",
      label: "Semantic search",
      blurb: "Turns a question into the notes that answer it.",
      state: embedOk ? "ok" : "degraded",
      detail: embedOk ? "answering" : "down — search falls back to full text, agents still get answers",
    },
  ];

  // Without the database there is nothing left to count, and every query below
  // would just be a second way to say the same outage.
  if (!dbOk) {
    return { state: "down", services, queue: null };
  }

  const [m] = await query<{
    pending: number;
    stuck: number;
    read_ok: number;
    read_failed: number;
    calls: number;
    calls_failed: number;
    payment_errors: number;
  }>(
    `select
       (select count(*) filter (where status in ('queued','processing'))::int from sources) as pending,
       (select count(*) filter (
          where status = 'processing'
            and coalesce(processing_at, created_at) < now() - interval '1 hour')::int
          from sources) as stuck,
       (select count(*) filter (where status = 'ready')::int from sources
         where processed_at > now() - interval '24 hours') as read_ok,
       -- Budget pauses are a plan doing its job, not a broken reader. Their
       -- reason rides on the source's error column, which is what tells the
       -- two apart.
       (select count(*) filter (
          where status = 'failed'
            and coalesce(error, '') not like '%budget: extraction paused%')::int
          from sources where processed_at > now() - interval '24 hours') as read_failed,
       (select count(*)::int from calls
         where created_at > now() - interval '1 hour') as calls,
       -- What "the Agent API is unwell" actually means.
       --
       -- It used to mean not-ok, which is set from a tool's isError — and
       -- isError is how every honest refusal answers: "top up your balance",
       -- "that is not in the set", "brain_find takes a question, not a name".
       -- Measured on prod, 23 of an hour's 75 calls were refusals of exactly
       -- that kind, every one of them the system working, and the tile went
       -- red. It would go red harder now: an anonymous caller is a stranger's
       -- agent meeting the tools for the first time, and its refusals — a
       -- write tool it may not reach, a rate limit it just hit — are the
       -- design, not a fault.
       --
       -- A call that genuinely broke is one that threw, and those already
       -- report themselves to app_errors under source 'mcp' (see the catch in
       -- lib/mcp-rpc). So count those. The number is small by construction,
       -- which is the point: a tile that is red most of the time is a tile
       -- nobody reads.
       (select count(*)::int from app_errors
         where source = 'mcp' and created_at > now() - interval '1 hour') as calls_failed,
       (select count(*)::int from app_errors
         where source = 'payments' and resolved_at is null
           and created_at > now() - interval '24 hours') as payment_errors`,
  );

  const read = m.read_ok + m.read_failed;
  // A single failure out of three reads is one bad PDF, not an incident. The
  // ratio only means anything once there is enough of a day to divide.
  const readBad = read >= 5 && m.read_failed / read > 0.5;

  services.push(
    {
      key: "queue",
      label: "Reading queue",
      blurb: "Pages, files and screenshots waiting to become notes.",
      state: m.stuck > 0 ? "down" : "ok",
      detail:
        m.stuck > 0
          ? `${m.stuck} source${m.stuck === 1 ? "" : "s"} wedged over an hour`
          : `${m.pending} in the queue, moving`,
    },
    {
      key: "extraction",
      label: "AI reading",
      blurb: "The model that turns a source into notes.",
      state: readBad ? "degraded" : "ok",
      detail: read === 0 ? "nothing read in 24h" : `${m.read_ok} of ${read} sources read in 24h`,
    },
    {
      key: "mcp",
      label: "Agent API (MCP)",
      blurb: "What Claude Code, Codex and Cursor actually call.",
      state: m.calls_failed > 0 ? "degraded" : "ok",
      detail:
        m.calls_failed > 0
          ? `${m.calls_failed} call${m.calls_failed === 1 ? "" : "s"} failed with an ` +
            `internal error this hour, of ${m.calls}`
          : m.calls === 0
            ? "no calls in the last hour"
            : `${m.calls} calls this hour, none broken`,
    },
    {
      key: "payments",
      label: "Payments",
      blurb: "Top-ups, purchases and payouts.",
      state: m.payment_errors > 0 ? "degraded" : "ok",
      detail:
        m.payment_errors > 0
          ? `${m.payment_errors} unresolved failure${m.payment_errors === 1 ? "" : "s"} in 24h`
          : "no failures in 24h",
    },
  );

  return {
    state: worst(services.map((s) => s.state)),
    services,
    queue: { pending: m.pending, stuck: m.stuck },
  };
}
