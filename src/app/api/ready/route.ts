import { NextResponse } from "next/server";
import { query } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Startup readiness, not health.
 *
 * The self-host worker waits on this (via the app's compose healthcheck) so
 * it never starts before migrations+admin bootstrap have finished. It checks
 * only the database on purpose: coupling worker startup to the embedder or
 * the queue's stuck-job count would deadlock on stale jobs — the worker is
 * what clears them.
 */
export async function GET() {
  const ok = await query("select 1").then(
    () => true,
    () => false,
  );
  if (!ok) {
    return NextResponse.json({ ready: false }, { status: 503 });
  }
  return NextResponse.json({ ready: true });
}
