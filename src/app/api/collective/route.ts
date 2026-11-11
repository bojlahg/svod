import { NextResponse } from "next/server";

/**
 * SVOD stage 2: the anonymous collective search is retired.
 *
 * It answered across every public brain without a user grant — exactly the
 * bypass the private boundary closes. Authenticated search lives behind
 * brain_search on bases the caller may open.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { error: "Gone: collective search is retired. Search a base you may open instead." },
    { status: 410 },
  );
}
