import { NextResponse } from "next/server";
import { maybeOne } from "@/db";
import { storage } from "@/lib/storage";
import { requireUser } from "@/lib/session";
import { brainAccessById } from "@/lib/svod-access";

/**
 * SVOD: a base's cover serves only to callers who may read the base.
 * Unknown, coverless and ungranted are the same 404 so a stranger cannot
 * probe which private bases have covers.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await requireUser(req).catch(() => null);
  const access = await brainAccessById(id, user?.id ?? null);
  if (!access?.canRead) {
    return new NextResponse(null, { status: 404 });
  }
  const brain = access.brain;

  if (!brain.cover_key) {
    return new NextResponse(null, { status: 404 });
  }

  const fromSource = await maybeOne<{ mime: string | null }>(
    `select mime from sources where storage_key = $1`,
    [brain.cover_key],
  );
  const ext = brain.cover_key.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
  };

  try {
    const body = await storage.get(brain.cover_key);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": fromSource?.mime ?? byExt[ext] ?? "image/jpeg",
        // Never cacheable: a role change must take effect on the next
        // request, not when a browser cache entry expires.
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
