import { NextResponse } from "next/server";
import { verifyToken, tokenOwnerFor } from "@/lib/tokens";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { handle, fail, MAX_BATCH, PROTOCOL_VERSION, type RpcRequest } from "@/lib/mcp-rpc";

/**
 * MCP endpoint — JSON-RPC 2.0 over HTTP.
 *
 * Hand-rolled rather than wired through the MCP SDK: its streamable transport
 * wants Node `req`/`res`, App Router hands us a Web `Request`, and the shim
 * between them is more moving parts than the protocol itself. A stateless
 * tools-only server needs `initialize`, `tools/list`, `tools/call` and `ping`.
 *
 * Auth is a bearer token (see /settings/tokens):
 *   claude mcp add --transport http svod https://example/mcp \
 *     --header "Authorization: Bearer mzg_..."
 */


/**
 * Why the call was refused, in words the agent can act on.
 *
 * "Unauthorized" is true and useless: the commonest cause by far is a plugin
 * whose MOZG_TOKEN was never exported, and the shell then sends the header
 * literally — the agent reads a bare 401, tells its user the brain is
 * unavailable, and nobody learns that one export line fixes it. Every branch
 * here names the fix.
 */
function unauthorizedReason(req: Request, base: string): string {
  const raw = req.headers.get("authorization");
  if (!raw) {
    return (
      "Unauthorized: no token. Make one at " + base + "/settings/tokens and set it as " +
      "SVOD_TOKEN in your shell profile (the plugin sends it), or sign in through " +
      "OAuth if your client supports it."
    );
  }
  // An unexpanded shell variable arrives verbatim. Recognising it saves the
  // user from debugging our server instead of their profile. The old name is
  // still recognised so a config that was not renamed gets the same hint.
  if (raw.includes("${") || raw.includes("$SVOD_TOKEN") || raw.includes("$MOZG_TOKEN")) {
    return (
      "Unauthorized: the token placeholder was sent unexpanded — your shell did " +
      "not have SVOD_TOKEN set when the MCP server started. Export it in your " +
      "profile (get one at " + base + "/settings/tokens) and restart the client."
    );
  }
  if (!/^bearer\s/i.test(raw)) {
    return 'Unauthorized: the Authorization header must read "Bearer mzg_...".';
  }
  return (
    "Unauthorized: this token is unknown, revoked, or belongs to a deleted " +
    "account. Check " + base + "/settings/tokens — issuing a new one takes a click."
  );
}

export async function POST(req: Request) {
  let owner = await verifyToken(req.headers.get("authorization"));

  // Second door: OAuth access tokens (ChatGPT connectors and every other
  // client that speaks MCP auth). Same Owner shape out, so nothing below
  // knows which door was used; quotas and metering run on userId either way.
  if (!owner) {
    try {
      const oauth = await auth.api.getMcpSession({ headers: req.headers as unknown as Headers });
      if (oauth?.userId) owner = await tokenOwnerFor(oauth.userId, "oauth");
    } catch {
      // An unparseable or expired OAuth token reads as "no session".
    }
  }

  if (!owner) {
    // 401 + WWW-Authenticate is what MCP clients look for to prompt for
    // auth; resource_metadata points OAuth-capable ones at discovery.
    // Behind nginx the request origin is localhost — the advertised URL must
    // be the public one.
    const base = env.NEXT_PUBLIC_APP_URL;
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: unauthorizedReason(req, base) } },
      {
        status: 401,
        headers: {
          "WWW-Authenticate":
            `Bearer realm="svod", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        },
      },
    );
  }

  let body: RpcRequest | RpcRequest[];
  try {
    body = await req.json();
  } catch {
    return fail(null, -32700, "Parse error", 400);
  }

  // Batches are legal JSON-RPC; clients rarely send them, but dropping them
  // silently would be a confusing failure. Capped, and run one at a time: the
  // burst and quota checks read the calls table, so a parallel batch would
  // pass every check before the first call was ever recorded.
  if (Array.isArray(body)) {
    if (body.length > MAX_BATCH) {
      return fail(null, -32600, `Batch too large: at most ${MAX_BATCH} requests per call.`);
    }
    const results = [];
    for (const r of body) results.push(await handle(r, owner));
    const responses = results.filter(Boolean);
    return responses.length
      ? NextResponse.json(responses)
      : new NextResponse(null, { status: 202 });
  }

  const response = await handle(body, owner);
  return response ? NextResponse.json(response) : new NextResponse(null, { status: 202 });
}

/** Some clients probe with GET before opening a session. */
export async function GET() {
  return NextResponse.json(
    { name: "svod", protocolVersion: PROTOCOL_VERSION, transport: "streamable-http" },
    { status: 200 },
  );
}
