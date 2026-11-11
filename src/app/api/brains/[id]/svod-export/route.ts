import { NextResponse } from "next/server";
import { brainAccessById } from "@/lib/svod-access";
import { requireUser } from "@/lib/session";
import { isUuid } from "@/lib/svod-folders";
import { fetchFullExport } from "@/lib/svod-import";
import { buildFullZip, buildMarkdownZip } from "@/lib/svod-transfer";

/**
 * SVOD stage 6 exports: full ZIP and Markdown ZIP.
 * Session + canRead; unknown/ungranted are 404 like the old export.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const found = await brainAccessById(id, user.id);
  if (!found?.canRead) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const format = new URL(req.url).searchParams.get("format") ?? "";
  if (format !== "full" && format !== "markdown") {
    return NextResponse.json({ error: "Unknown format." }, { status: 400 });
  }

  const data = await fetchFullExport(found.brain.id, found.canReview);
  if (format === "full") {
    const body = buildFullZip({
      brain: data.brain,
      folders: data.folders,
      notes: data.notes.map((n) => ({
        id: n.id,
        folder_id: n.folder_id,
        title: n.title,
        body: n.body,
        status: n.status,
        category: n.category,
        kind: n.kind,
        author: n.author,
        revision: n.revision,
        target_note_id: n.target_note_id,
        target_revision: n.target_revision,
        proposed_by: n.proposed_by,
        token_id: n.token_id,
        token_label: n.token_label,
      })),
      sources: data.sources,
      chunks: data.chunks,
      attachments: data.attachments,
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="svod-${found.brain.slug}-full.zip"`,
        "cache-control": "private, no-store",
      },
    });
  }

  const body = buildMarkdownZip(
    data.notes.filter((n) => n.status === "active").map((n) => ({ id: n.id, folder_id: n.folder_id, title: n.title, body: n.body })),
    data.folders,
  );
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="svod-${found.brain.slug}-markdown.zip"`,
      "cache-control": "private, no-store",
    },
  });
}
