import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { isUuid } from "@/lib/svod-folders";
import { workspaceBrain } from "@/lib/svod-access";
import { isWorkspaceSameOriginRequest } from "@/lib/svod-workspace-origin";
import {
  createFolder,
  createSvodNoteAction,
  editSvodNoteAction,
  moveSvodNoteAction,
  renameBase,
  renameFolder,
  uploadMdAction,
} from "@/app/brains/[slug]/svod-actions";

// Hydrated workspace mutations (JSON for text, multipart for .md upload, no Flight).
// Reuses svod-actions for auth/validation/storage; route base overrides caller brainId.
const MAX_WORKSPACE_BODY = 1024 * 1024;

export type SvodWorkspaceOp =
  | "foldercreate"
  | "folderrename"
  | "baserename"
  | "notemove"
  | "notecreate"
  | "noteedit"
  | "markdownupload";

const handlers: Record<SvodWorkspaceOp, (fd: FormData) => Promise<unknown>> = {
  baserename: (fd) => renameBase(fd),
  foldercreate: (fd) => createFolder(fd),
  folderrename: (fd) => renameFolder(fd),
  notemove: (fd) => moveSvodNoteAction(fd),
  notecreate: (fd) => createSvodNoteAction(fd),
  noteedit: (fd) => editSvodNoteAction(fd),
  markdownupload: (fd) => uploadMdAction(null, fd),
};

function isSameOrigin(req: Request): boolean {
  return isWorkspaceSameOriginRequest(req);
}

function statusFor(result: unknown): number {
  if (result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok) {
    return 200;
  }
  if (result && typeof result === "object" && "error" in result) {
    return (result as { error?: unknown }).error === "Base not found." ? 404 : 400;
  }
  return 200;
}

type BoundedRaw = { ok: true; raw: Uint8Array<ArrayBuffer> } | { ok: false; reason: "too-large" | "bad" };

async function boundedRaw(req: Request): Promise<BoundedRaw> {
  const cl = req.headers.get("content-length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > MAX_WORKSPACE_BODY) return { ok: false, reason: "too-large" };
  }
  if (!req.body) return { ok: false, reason: "bad" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WORKSPACE_BODY) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too-large" };
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    raw.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, raw };
}

function jsonToFormData(value: unknown): FormData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fd = new FormData();
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith("$ACTION")) continue;
    if (typeof v !== "string") return null;
    fd.set(k, v);
  }
  return fd;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const { id: routeId } = await ctx.params;
  if (!isUuid(routeId)) {
    return NextResponse.json({ error: "Base not found." }, { status: 404 });
  }
  const access = await workspaceBrain(routeId, user.id);
  if (!access?.canEdit) {
    return NextResponse.json({ error: "Base not found." }, { status: 404 });
  }

  const rawBody = await boundedRaw(req);
  if (!rawBody.ok) {
    return rawBody.reason === "too-large"
      ? NextResponse.json({ error: "Request is too large." }, { status: 413 })
      : NextResponse.json({ error: "Expected form data." }, { status: 400 });
  }
  const ct = req.headers.get("content-type") ?? "";
  let fd: FormData;
  if (ct.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody.raw));
    } catch {
      return NextResponse.json({ error: "Malformed JSON." }, { status: 400 });
    }
    const converted = jsonToFormData(parsed);
    if (!converted) {
      return NextResponse.json({ error: "Malformed JSON." }, { status: 400 });
    }
    fd = converted;
  } else if (ct.includes("multipart/form-data")) {
    try {
      const copy = new Request(req.url, {
        method: "POST",
        headers: { "content-type": ct },
        body: rawBody.raw,
      });
      fd = await copy.formData();
    } catch {
      return NextResponse.json({ error: "Expected form data." }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "Expected form data." }, { status: 400 });
  }
  const op = String(fd.get("op") ?? "");
  if (!Object.hasOwn(handlers, op)) {
    return NextResponse.json({ error: "Unknown operation." }, { status: 400 });
  }
  if (op !== "markdownupload" && ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Use JSON for this operation." }, { status: 400 });
  }
  if (op === "markdownupload" && !ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected form data." }, { status: 400 });
  }

  fd.set("brainId", access.brain.id);

  try {
    const r = await handlers[op as SvodWorkspaceOp](fd);
    return NextResponse.json(r, { status: statusFor(r) });
  } catch (e) {
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    }
    throw e;
  }
}
