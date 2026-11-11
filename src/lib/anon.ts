import { createHash } from "node:crypto";
import { maybeOne } from "@/db";
import { env } from "@/lib/env";
import type { Owner } from "@/lib/mcp-rpc";

/**
 * The anonymous MCP caller.
 *
 * Everything an agent can do without a token, and nothing else. The point is
 * the four steps it deletes — register, issue a token, export it into the
 * shell, learn the tool names — between hearing about mozg and getting an
 * answer out of it. A catalogue nobody can try is a catalogue nobody adopts,
 * and the self-learning loop is fed by usage: a search that comes back empty
 * is the only signal about what a brain is missing that nobody had to write,
 * so anonymous traffic is not just tolerated here, it is the input.
 */

/** Metered against one real row, so calls.caller_id's foreign key holds. */
export const ANON_USER_ID = "anon";

/**
 * What an anonymous caller may do: read, and nothing that writes or spends.
 *
 * An allowlist rather than a denylist, because the failure modes are not
 * symmetrical. A read tool missing from this list is an inconvenience someone
 * reports; a write tool that reaches it by default is unsigned strangers
 * queueing extraction on our bill, or filing note proposals into other
 * people's brains. Every tool added later is denied until it is named here,
 * which is the right way round.
 */
export const ANON_TOOLS = new Set([
  "brain_list",
  "brain_find",
  "brain_search",
  "brain_read",
  "brain_brief",
]);

/**
 * Per-person ceilings. Deliberately generous per minute and firm per day: a
 * real agent exploring a brain makes bursts of searches and then stops, while
 * anything scraping the catalogue is steady and long. A search costs CPU on
 * our own index rather than tokens, so the daily number can be a number
 * somebody could actually use for a day's work and still stop a crawler.
 */
export const ANON_PER_MINUTE = 20;
export const ANON_PER_DAY = 300;

/**
 * Who is calling, as a salted hash of their address.
 *
 * Salted with the app secret so the column cannot be turned back into a list
 * of who read what by anyone who gets a copy of the table — an IP is personal
 * data and this endpoint takes no consent for it.
 *
 * Behind nginx the socket address is always localhost, so the left-most entry
 * of X-Forwarded-For is the only real one. It is client-controlled and worth
 * exactly what that implies: forging it buys a fresh rate-limit bucket, the
 * same thing a proxy buys. That is the ceiling of what this defends, and it
 * is the right ceiling — the tools behind it only read free public material.
 */
export function callerHash(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(`${env.BETTER_AUTH_SECRET}:${ip}`).digest("hex").slice(0, 32);
}

export interface AnonOwner extends Owner {
  ipHash: string;
}

/** The principal an anonymous request runs as. Free plan, no shelf, no keys. */
export function anonOwner(req: Request): AnonOwner {
  return {
    userId: ANON_USER_ID,
    tokenId: "anon",
    plan: "free",
    canCreateProject: false,
    ipHash: callerHash(req),
  };
}

/**
 * Has this caller used up a window? Returns the message to send, or null.
 *
 * Both windows are read in one query: two round-trips per call on the
 * cheapest surface we have would be the most expensive part of it.
 */
export async function anonRateLimited(ipHash: string): Promise<string | null> {
  const row = await maybeOne<{ minute: number; day: number }>(
    `select
       count(*) filter (where created_at > now() - interval '1 minute')::int as minute,
       count(*) filter (where created_at > now() - interval '24 hours')::int as day
     from calls where caller_ip_hash = $1 and created_at > now() - interval '24 hours'`,
    [ipHash],
  );
  if ((row?.minute ?? 0) >= ANON_PER_MINUTE) {
    return `Rate limit: ${ANON_PER_MINUTE} anonymous calls a minute. Wait a moment, or connect with a token from https://mozg.sh/connect for the full quota.`;
  }
  if ((row?.day ?? 0) >= ANON_PER_DAY) {
    return `Daily limit: ${ANON_PER_DAY} anonymous calls. A free account at https://mozg.sh lifts it, costs nothing, and adds the tools that write.`;
  }
  return null;
}
