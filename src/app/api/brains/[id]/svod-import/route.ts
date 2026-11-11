import { NextResponse } from "next/server";
import { query } from "@/db";
import { brainAccessById } from "@/lib/svod-access";
import { requireUser } from "@/lib/session";
import { isUuid } from "@/lib/svod-folders";
import { isWorkspaceSameOriginRequest } from "@/lib/svod-workspace-origin";
import {
  SVOD_ENTRY_MAX,
  SVOD_REQUEST_MAX,
  SvodArchiveError,
  classifyEntries,
  decodeMdBytesStrict,
  parseZip,
  planFullImport,
  planMarkdownImport,
} from "@/lib/svod-transfer";
import { commitFullImport, commitMarkdownImport } from "@/lib/svod-import";

/**
 * SVOD stage 6 import: full ZIP or Markdown set into the URL base.
 * Session + canEdit (403 when readable, 404 when not). Same-origin only.
 * Preview writes nothing; commit runs one transaction.
 */

type Phase = "preview" | "commit";

function phaseOf(req: Request, fd: FormData | null): Phase | null {
  const q = new URL(req.url).searchParams.get("phase");
  const f = fd ? String(fd.get("phase") ?? "") : "";
  const v = q || f || "preview";
  if (v === "preview" || v === "commit") return v;
  return null;
}

function decisionOf(req: Request, fd: FormData | null): string {
  const q = new URL(req.url).searchParams.get("decision") ?? "";
  const f = fd ? String(fd.get("decision") ?? "") : "";
  return q || f || "";
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isWorkspaceSameOriginRequest(req)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const access = await brainAccessById(id, user.id);
  if (!access?.canRead) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!access.canEdit) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const brainId = access.brain.id;

  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > SVOD_REQUEST_MAX + 8 * 1024 * 1024) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
  }

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected form data." }, { status: 400 });
  }
  const phase = phaseOf(req, fd);
  if (!phase) return NextResponse.json({ error: "Unknown phase." }, { status: 400 });
  const decision = decisionOf(req, fd);
  if (phase === "commit" && decision !== "update" && decision !== "skip") {
    return NextResponse.json({ error: "Choose what to do with matches." }, { status: 400 });
  }

  const rawFiles = fd.getAll("file").filter((v): v is File => v instanceof File);
  if (!rawFiles.length) return NextResponse.json({ error: "Choose a file." }, { status: 400 });

  const isZipName = (name: string): boolean => name.toLowerCase().endsWith(".zip");
  let useZip = false;
  if (rawFiles.length === 1) {
    const f = rawFiles[0];
    if (isZipName(f.name || "")) useZip = true;
    else {
      try {
        const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
          useZip = true;
        }
      } catch {
        useZip = false;
      }
    }
  }

  if (useZip) {
    const f = rawFiles[0];
    if (f.size > SVOD_REQUEST_MAX) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(await f.arrayBuffer());
    } catch {
      return NextResponse.json({ error: "Could not read the file." }, { status: 400 });
    }
    if (buf.length > SVOD_REQUEST_MAX) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    let classified;
    try {
      classified = classifyEntries(parseZip(buf));
    } catch (e) {
      if (e instanceof SvodArchiveError) return NextResponse.json({ error: e.message }, { status: 400 });
      return NextResponse.json({ error: "Archive is not readable." }, { status: 400 });
    }
    if (classified.kind === "full" && classified.full) {
      const archive = classified.full;
      if (phase === "preview") {
        const targetFolders = await query<{ id: string; parent_id: string | null; name: string }>(
          `select id, parent_id, name from folders where brain_id = $1`,
          [brainId],
        );
        const targetNotes = await query<{ id: string; folder_id: string | null; title: string; body: string; status: string }>(
          `select id, folder_id, title, body, status from notes where brain_id = $1`,
          [brainId],
        );
        const targetById = new Map(targetNotes.map((n) => [n.id, n]));
        const globalNoteBrain = new Map<string, string>();
        for (const n of archive.notes) {
          try {
            const r = await query<{ brain_id: string }>(`select brain_id from notes where id = $1`, [n.id]);
            if (r[0]) globalNoteBrain.set(n.id, r[0].brain_id);
          } catch {
            // stubbed pool: treat as free
          }
        }
        const globalFolderIds = new Set<string>();
        for (const fo of archive.folders) {
          try {
            const r = await query(`select id from folders where id = $1`, [fo.id]);
            if (r.length) globalFolderIds.add(fo.id);
          } catch {}
        }
        const plan = planFullImport({ archive, targetBrainId: brainId, targetFolders, targetNotesById: targetById, globalNoteBrain, globalFolderIds });
        return NextResponse.json({ format: "full", adds: plan.adds, matches: plan.matches, conflicts: plan.conflicts, errors: plan.errors });
      }
      const r = await commitFullImport({ brainId, archive, attachments: classified.attachments, decision: decision as "update" | "skip" });
      return NextResponse.json({ format: "full", ...r });
    }
    // Markdown ZIP inside one .zip.
    const mdInputs: { name: string; body: string }[] = [];
    const mdErrors: string[] = [];
    for (const e of classified.mdFiles) {
      if (e.body.length > SVOD_ENTRY_MAX) {
        mdErrors.push(`File "${e.name}" is too large; skipped.`);
        continue;
      }
      const d = decodeMdBytesStrict(e.body);
      if (!d.ok) {
        mdErrors.push(`File "${e.name}" is not UTF-8; skipped.`);
        continue;
      }
      mdInputs.push({ name: e.name, body: d.text });
    }
    if (phase === "preview") {
      const targetFolders = await query<{ id: string; parent_id: string | null; name: string }>(
        `select id, parent_id, name from folders where brain_id = $1`,
        [brainId],
      );
      const targetNotes = await query<{ id: string; folder_id: string | null; title: string; body: string }>(
        `select id, folder_id, title, body from notes where brain_id = $1 and status = 'active'`,
        [brainId],
      );
      const plan = planMarkdownImport({ files: mdInputs, targetFolders, targetNotes });
      return NextResponse.json({
        format: "markdown",
        adds: plan.adds,
        matches: plan.matches,
        conflicts: plan.conflicts,
        errors: [...mdErrors, ...plan.errors],
      });
    }
    const r = await commitMarkdownImport({ brainId, files: mdInputs, decision: decision as "update" | "skip" });
    return NextResponse.json({ format: "markdown", ...r, errors: [...mdErrors, ...r.errors] });
  }

  // Several .md files (browser directory posts relative paths as file names).
  const mdInputs: { name: string; body: string }[] = [];
  const mdErrors: string[] = [];
  let total = 0;
  if (rawFiles.length > 20000) return NextResponse.json({ error: "Too many files." }, { status: 400 });
  for (const f of rawFiles) {
    const name = f.name || "note.md";
    if (!name.toLowerCase().endsWith(".md")) {
      mdErrors.push(`File "${name}" is not Markdown; skipped.`);
      continue;
    }
    if (f.size > SVOD_ENTRY_MAX) {
      mdErrors.push(`File "${name}" is too large; skipped.`);
      continue;
    }
    total += f.size;
    if (total > SVOD_REQUEST_MAX) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    let buf: Buffer;
    try {
      buf = Buffer.from(await f.arrayBuffer());
    } catch {
      mdErrors.push(`File "${name}" is unreadable; skipped.`);
      continue;
    }
    const d = decodeMdBytesStrict(buf);
    if (!d.ok) {
      mdErrors.push(`File "${name}" is not UTF-8; skipped.`);
      continue;
    }
    // Multipart names may carry a browser relative path already.
    mdInputs.push({ name, body: d.text });
  }
  if (!mdInputs.length && mdErrors.length) {
    return NextResponse.json({ format: "markdown", adds: [], matches: [], conflicts: [], errors: mdErrors });
  }
  if (phase === "preview") {
    const targetFolders = await query<{ id: string; parent_id: string | null; name: string }>(
      `select id, parent_id, name from folders where brain_id = $1`,
      [brainId],
    );
    const targetNotes = await query<{ id: string; folder_id: string | null; title: string; body: string }>(
      `select id, folder_id, title, body from notes where brain_id = $1 and status = 'active'`,
      [brainId],
    );
    const plan = planMarkdownImport({ files: mdInputs, targetFolders, targetNotes });
    return NextResponse.json({
      format: "markdown",
      adds: plan.adds,
      matches: plan.matches,
      conflicts: plan.conflicts,
      errors: [...mdErrors, ...plan.errors],
    });
  }
  const r = await commitMarkdownImport({ brainId, files: mdInputs, decision: decision as "update" | "skip" });
  return NextResponse.json({ format: "markdown", ...r, errors: [...mdErrors, ...r.errors] });
}
