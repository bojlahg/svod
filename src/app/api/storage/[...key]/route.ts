import { NextResponse } from "next/server";
import { maybeOne } from "@/db";
import { storage } from "@/lib/storage";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { canRead } from "@/lib/access";

/**
 * Serves stored objects for the local-disk driver (dev). In production the S3
 * driver hands out presigned URLs and this route is never hit.
 *
 * Access is checked against the owning brain — the storage key is not a secret.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ key: string[] }> },
) {
  if (env.STORAGE_DRIVER !== "local") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { key } = await ctx.params;
  const storageKey = key.join("/");

  const source = await maybeOne<{ brain_id: string; mime: string | null }>(
    `select brain_id, mime from sources where storage_key = $1`,
    [storageKey],
  );
  if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });

  const user = await requireUser(req).catch(() => null);
  // Unknown, missing and ungranted are the same 404: the storage key is not
  // a secret, and the status must not say which private base holds it.
  if (!(await canRead(source.brain_id, user?.id ?? null))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const body = await storage.get(storageKey);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": source.mime ?? "application/octet-stream",
        // Never cacheable: a role change must take effect on the next
        // request, not when a browser cache entry expires.
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
