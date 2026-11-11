import { NextResponse } from "next/server";
import { query, maybeOne } from "@/db";
import { TOOLS, callTool } from "@/lib/mcp";
import { reportError } from "@/lib/errors";
import { burstExceeded, type TokenOwner } from "@/lib/tokens";
import { captureServer } from "@/lib/analytics";
import { CLOSED } from "@/middleware";

/**
 * The JSON-RPC dispatch behind every MCP door.
 *
 * Lifted out of the route the day a second door appeared — /mcp/public, which
 * answers without a token. Two copies of this would be two places to add a
 * tool and one place to forget a quota check, and the check that gets
 * forgotten is always the one on the door nobody was thinking about.
 *
 * A route decides WHO is calling. This decides what happens next, and is
 * identical whichever way they got in.
 */

export type Owner = TokenOwner & {
  /**
   * Set for anonymous callers: a salted hash of their address.
   *
   * They all share one caller_id (the foreign key needs a real user row), so
   * this is what separates one anonymous person from another — for the rate
   * limit, and for the search-gap harvest, which only promotes a miss to an
   * exam question once two DIFFERENT people have hit it.
   */
  ipHash?: string;
  /**
   * When present, the only tools this caller may use. Absent for a token or
   * OAuth caller, who may use all of them.
   */
  allowedTools?: Set<string>;
};

export const PROTOCOL_VERSION = "2025-06-18";

/** See the batch note in POST: larger batches would outrun the quota checks. */
export const MAX_BATCH = 10;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const fail = (id: RpcRequest["id"], code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });

/** Tool arguments, whether the client sent an object or the JSON string of one. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}


/** Returns null for notifications, which must not get a response body. */
export async function handle(rpc: RpcRequest, owner: Owner) {
  const { id, method, params = {} } = rpc;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0" as const,
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mozg", version: "0.1.0" },
          // Written as a working order rather than a description. The old
          // version said what the tools were for and left the agent to infer
          // when — which it did by never inferring it, and answering from
          // training data with a brain sitting one call away. Each line names
          // the moment, because a moment is what an agent can act on.
          instructions:
            "mozg holds project-specific knowledge brains — material that is " +
            "newer than your training data and scored against an exam.\n" +
            "- Call brain_list once at the start of a session.\n" +
            "- Call brain_brief on a brain before your first search in it: it " +
            "returns the vocabulary to search with, the gaps not to trust, and " +
            "any unfinished work left by an earlier session.\n" +
            "- Call brain_search BEFORE answering whenever the question touches " +
            "this project's conventions, file layout, versions, APIs, or any " +
            "\"how do we do X here\" — your training data does not know these " +
            "and will sound confident anyway. Skip it for general programming " +
            "questions the brain has no stake in.\n" +
            "- Call brain_write after working something out that cost real " +
            "effort to find and would cost the next session the same. On brains " +
            "you only read, this becomes a proposal for the owner — still worth " +
            "sending.\n" +
            "- Call brain_handoff to leave working state when you stop mid-task.",
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { jsonrpc: "2.0" as const, id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0" as const, id, result: { tools: TOOLS } };

    case "tools/call": {
      const name = String(params.name ?? "");
      // Some clients forward the model's tool call verbatim and send
      // `arguments` as the JSON *string* it arrived in. Every field then reads
      // as undefined and the tool answers "title and body are required" to a
      // caller that sent both — so parse the quoted form before dispatching.
      const args = parseArgs(params.arguments);

      // A tool that does not exist is a protocol error, not a tool that ran
      // and failed. A client working from a stale tool list has to be able to
      // tell those apart — otherwise it reads "Unknown tool" as an answer and
      // tries again with the same name.
      if (!TOOLS.some((t) => t.name === name)) {
        return {
          jsonrpc: "2.0" as const,
          id,
          error: {
            code: -32602,
            message: `Unknown tool: ${name}. Call tools/list for what is available.`,
          },
        };
      }

      // mozg is paused for 2.0 (see CLOSED in middleware.ts). The operator's
      // own agents keep working; everyone else is told why, in words an agent
      // will relay rather than retry.
      if (CLOSED && owner.plan !== "admin") {
        return {
          jsonrpc: "2.0" as const,
          id,
          result: {
            content: [
              {
                type: "text",
                text:
                  "mozg is temporarily closed while mozg 2.0 is built. Nothing is " +
                  "deleted — tell the user the brains will be back when it reopens " +
                  "(https://mozg.sh), and answer without mozg for now. Do not retry.",
              },
            ],
            isError: true,
          },
        };
      }

      // What this caller may reach at all. Checked before the quota so a tool
      // that was never available does not consume one.
      if (owner.allowedTools && !owner.allowedTools.has(name)) {
        return {
          jsonrpc: "2.0" as const,
          id,
          result: {
            content: [
              {
                type: "text",
                text:
                  `${name} needs an account. Anonymous access reads the free public ` +
                  "catalogue; anything that writes, spends or owns needs a token from " +
                  "https://mozg.sh/connect — a free account takes a moment and costs nothing.",
              },
            ],
            isError: true,
          },
        };
      }

      // SVOD private fork: no paid monthly quota on the private path. The
      // burst ceiling stays as the abuse guard; anonymous callers are gone
      // (the public door is retired), so every caller here is authenticated.
      if (!owner.ipHash && (await burstExceeded(owner.userId))) {
        return {
          jsonrpc: "2.0" as const,
          id,
          result: {
            content: [
              {
                type: "text",
                text:
                  "Rate limited: more than 60 calls in the last minute. Wait a " +
                  "moment before searching again, and prefer fewer, more specific " +
                  "queries over many broad ones.",
              },
            ],
            isError: true,
          },
        };
      }

      const started = Date.now();
      let outcome;
      try {
        outcome = await callTool(name, args, owner);
      } catch (err) {
        // 22P02: an id argument that is not a uuid ("" from an agent that lost
        // the note_id, a title pasted where the id goes). Every id-taking tool
        // hands its argument straight to postgres, so this is the one place
        // that sees them all — and it is the caller's mistake, not ours.
        if ((err as { code?: string })?.code === "22P02") {
          outcome = {
            text:
              "An id you passed is not a valid id (empty or malformed). Ids come " +
              "from brain_search / brain_list results — search again and pass one verbatim.",
            isError: true,
          };
        } else {
          // err.message can carry pg details (relation names, constraint text) —
          // schema information a caller has no business seeing. Report it to the
          // error center (admin-only surface), answer with something generic.
          reportError("mcp", name, err, { userId: owner.userId });
          outcome = {
            text: "Tool failed with an internal error. The details are logged; do not retry the same call.",
            isError: true,
          };
        }
      }

      // Metering is the same table billing will read — record every call,
      // including the failed ones, or the numbers lie. Awaited rather than
      // fire-and-forget so a batched call's burst/quota check sees the calls
      // before it; a failed insert must still not fail the tool call.
      await query(
        `insert into calls
           (brain_id, caller_id, caller_ip_hash, owner_id, tool, query, results,
            top_score, latency_ms, ok, error)
         values ($1, $2, $11, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          outcome.brainId ?? null,
          owner.userId,
          outcome.ownerId ?? null,
          name,
          typeof args.query === "string" ? args.query.slice(0, 500) : null,
          outcome.results ?? null,
          outcome.topScore ?? null,
          Date.now() - started,
          !outcome.isError,
          // The reason rides with the row: 24 failed calls once took latency
          // forensics to explain because ok=false carried no text.
          outcome.isError ? outcome.text.slice(0, 300) : null,
          owner.ipHash ?? null,
        ],
      ).catch(() => {});

      // The v1 activation metric (PLAN.md): signup → first brain_search. The
      // metering row above just landed, so a count of one means this was it.
      if (name === "brain_search" && !outcome.isError) {
        const seen = await maybeOne<{ n: number }>(
          `select count(*)::int as n from calls
            where caller_id = $1 and tool = 'brain_search'`,
          [owner.userId],
        ).catch(() => null);
        if (seen?.n === 1) {
          captureServer(owner.userId, "first_brain_search", {
            brain_id: outcome.brainId ?? null,
          });
        }
      }

      return {
        jsonrpc: "2.0" as const,
        id,
        result: {
          content: [{ type: "text", text: outcome.text }],
          isError: outcome.isError ?? false,
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0" as const,
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
