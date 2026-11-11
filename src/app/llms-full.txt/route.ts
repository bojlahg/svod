import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** SVOD stage 2: machine catalogue exports are retired with the catalogue. */
export function GET(): Response {
  return NextResponse.json({ error: "Gone." }, { status: 410 });
}
