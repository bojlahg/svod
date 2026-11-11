import { NextResponse } from "next/server";

/**
 * SVOD stage 2: the anonymous MCP door is retired.
 *
 * A private application boundary means no content without a user grant.
 * Authenticated clients use /mcp with a bearer token or OAuth session;
 * anonymous callers get a 410 with the way back, not a read-only catalogue.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message:
          "Anonymous MCP access is retired: this service is private. " +
          "Sign in, get a token, and call /mcp with Authorization: Bearer mzg_....",
      },
    },
    { status: 410 },
  );
}

export async function GET() {
  return NextResponse.json(
    {
      name: "svod (private)",
      auth: "required — anonymous access retired in stage 2",
    },
    { status: 410 },
  );
}
