import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** SVOD stage 2: retired with the public catalogue workflow. */
export function GET(): Response {
  return NextResponse.json({ error: "Gone." }, { status: 410 });
}
