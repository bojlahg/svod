import { NextResponse } from "next/server";
import { maybeOne } from "@/db";
import type { Note } from "@/db/types";
import { brainAccessById } from "@/lib/svod-access";
import { requireUser } from "@/lib/session";
import { isUuid } from "@/lib/svod-folders";
import { downloadFileParts } from "@/lib/svod-download";

/**
 * SVOD stage 3 exact-original download: the stored body byte-for-byte
 * (language, whitespace, fences, line endings as saved). Gated by role —
 * active notes for any reader, pending only for reviewers; unknown/ungranted
 * and malformed IDs are the same 404 and a forged note ID from another base
 * is denied by the brain_id + status check, not by the link. Cyrillic titles
 * use an ASCII fallback plus RFC 5987 filename*.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const { id, noteId } = await ctx.params;

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  if (!isUuid(id) || !isUuid(noteId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const found = await brainAccessById(id, user.id);
  if (!found?.canRead) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Active-only for normal reading; pending stays reviewer-only.
  const note = await maybeOne<Note>(
    `select * from notes where id = $1 and brain_id = $2 and status = 'active'`,
    [noteId, found.brain.id],
  );
  const pending = note
    ? null
    : found.canReview
      ? await maybeOne<Note>(
          `select * from notes where id = $1 and brain_id = $2 and status = 'pending'`,
          [noteId, found.brain.id],
        )
      : null;
  const row = note ?? pending;
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { header } = downloadFileParts(row.title, row.id);

  return new NextResponse(row.body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": header,
      "cache-control": "private, no-store",
    },
  });
}
