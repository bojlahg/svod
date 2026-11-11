import { NextResponse } from "next/server";
import { tx } from "@/db";
import type { Source } from "@/db/types";
import { requireUser } from "@/lib/session";
import { brainAccessById } from "@/lib/svod-access";
import { storage, storageKey } from "@/lib/storage";
import { enqueueIngest } from "@/worker/queue";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
]);
const PDF_TYPE = "application/pdf";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const { id } = await ctx.params;
  // Editors and above may upload; readers cannot. Unknown and ungranted are
  // the same 404 so a forged ID reveals nothing.
  const access = await brainAccessById(id, user.id);
  if (!access?.canEdit) {
    return NextResponse.json({ error: "Brain not found." }, { status: 404 });
  }
  const brain = access.brain;

  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) {
    return NextResponse.json({ error: "No files received." }, { status: 400 });
  }

  // SVOD: no plan source caps — workspace upload is gated by role only.
  const accepted: Source[] = [];
  const rejected: { name: string; reason: string }[] = [];

  const done = await tx(async (client) => {
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        rejected.push({ name: file.name, reason: "over 20 MB" });
        continue;
      }

      const isImage = IMAGE_TYPES.has(file.type);
      const isPdf = file.type === PDF_TYPE;
      const isText = TEXT_TYPES.has(file.type) || file.type === "";
      if (!isImage && !isPdf && !isText) {
        rejected.push({ name: file.name, reason: `unsupported type ${file.type}` });
        continue;
      }
      if (isPdf && file.size > MAX_PDF_BYTES) {
        rejected.push({ name: file.name, reason: "PDF over 20 MB — split it first" });
        continue;
      }

      const body = Buffer.from(await file.arrayBuffer());
      const key = storageKey(brain.id, file.name);
      await storage.put(key, body, file.type || "application/octet-stream");

      const { rows } = await client.query<Source>(
        `insert into sources (brain_id, kind, storage_key, original_name, mime, bytes)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [
          brain.id,
          isImage ? "image" : isPdf ? "file" : "text",
          key,
          file.name,
          file.type,
          body.length,
        ],
      );
      accepted.push(rows[0]);
    }
    return true;
  });
  void done;

  for (const source of accepted) await enqueueIngest(source.id);

  return NextResponse.json({
    accepted: accepted.length,
    rejected,
    sources: accepted.map((s) => ({ id: s.id, name: s.original_name, status: s.status })),
  });
}
