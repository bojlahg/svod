"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query } from "@/db";
import { currentUser } from "@/lib/session";
import { workspaceBrain } from "@/lib/svod-access";
import { folderInBrain, isUuid, validateBaseTitle, validateFolderName } from "@/lib/svod-folders";
import {
  MAX_MD_UPLOAD_BYTES,
  createSvodNote,
  decodeMdBytes,
  deleteSvodNote,
  moveSvodNote,
  updateSvodNote,
  validateNoteBody,
  validateNoteTitle,
} from "@/lib/svod-notes";

/**
 * SVOD stage 3 workspace mutations: folders + Markdown notes.
 *
 * Every action re-resolves the base through the shared policy by its stable
 * identifier (UUID or owned slug) and re-checks folder/note IDs against that
 * base — never trusting a form field or a selection link. Readers (canRead)
 * get no mutation; editors (canEdit) get content ops; reviewers keep their
 * queue (see review-actions); owners/operators keep admin via share page.
 *
 * Only folder creation/rename and note moves exist here (plus note CRUD):
 * folder brain_id/parent_id are immutable after creation (native constraint +
 * trigger), so there are no folder move/delete mutations to race.
 * All writes are atomic (see lib/svod-notes): body/status and lexical chunks
 * land together, moves keep IDs, no-op saves keep vectors and chunk IDs.
 */

function brainParam(formData: FormData): string {
  // The workspace always posts the stable base ID; slugs still resolve for
  // deep links typed by hand. Either way the policy decides by DB IDs.
  return String(formData.get("brainId") ?? formData.get("slug") ?? "");
}

async function editableBrain(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const access = await workspaceBrain(brainParam(formData), user.id);
  if (!access?.canEdit) return null;
  return { user, brain: access.brain };
}

function revalidateBrain(brainId: string, slug: string) {
  revalidatePath(`/brains/${brainId}`);
  if (slug !== brainId) revalidatePath(`/brains/${slug}`);
  revalidatePath("/brains");
}

export async function renameBase(formData: FormData) {
  const found = await editableBrain(formData);
  if (!found) return { error: "Base not found." };
  const v = validateBaseTitle(formData.get("title"));
  if (!v.ok) return { error: v.error };
  await query(`update brains set title = $2 where id = $1`, [found.brain.id, v.title]);
  revalidateBrain(found.brain.id, found.brain.slug);
  return { ok: true as const };
}

export async function createFolder(formData: FormData) {
  const found = await editableBrain(formData);
  if (!found) return { error: "Base not found." };
  const v = validateFolderName(formData.get("name"));
  if (!v.ok) return { error: v.error };
  const rawParent = String(formData.get("parentId") ?? "").trim();
  const parentId = rawParent || null;
  if (parentId) {
    if (!isUuid(parentId)) return { error: "Folder is in another base." };
    const parent = await folderInBrain(parentId, found.brain.id);
    if (!parent) return { error: "Folder is in another base." };
  }
  try {
    await query(`insert into folders (brain_id, parent_id, name) values ($1, $2, $3)`, [
      found.brain.id,
      parentId,
      v.name,
    ]);
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      return { error: "A folder with this name already exists here." };
    }
    throw e;
  }
  revalidateBrain(found.brain.id, found.brain.slug);
  return { ok: true as const };
}

export async function renameFolder(formData: FormData) {
  const found = await editableBrain(formData);
  if (!found) return { error: "Base not found." };
  const folderId = String(formData.get("folderId") ?? "");
  if (!isUuid(folderId)) return { error: "Folder not found." };
  const v = validateFolderName(formData.get("name"));
  if (!v.ok) return { error: v.error };
  const folder = await folderInBrain(folderId, found.brain.id);
  if (!folder) return { error: "Folder not found." };
  try {
    await query(`update folders set name = $3, updated_at = now() where id = $1 and brain_id = $2`, [
      folderId,
      found.brain.id,
      v.name,
    ]);
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      return { error: "A folder with this name already exists here." };
    }
    throw e;
  }
  revalidateBrain(found.brain.id, found.brain.slug);
  return { ok: true as const };
}

export async function createSvodNoteAction(formData: FormData) {
  const found = await editableBrain(formData);
  if (!found) return { error: "Base not found." };
  const titleV = validateNoteTitle(formData.get("title"));
  if (!titleV.ok) return { error: titleV.error };
  const bodyV = validateNoteBody(formData.get("body"));
  if (!bodyV.ok) return { error: bodyV.error };
  const rawFolder = String(formData.get("folderId") ?? "").trim();
  const folderId = rawFolder || null;
  if (folderId && !isUuid(folderId)) return { error: "Folder is in another base." };
  try {
    const note = await createSvodNote({
      brainId: found.brain.id,
      folderId,
      title: titleV.title,
      body: bodyV.body,
    });
    revalidateBrain(found.brain.id, found.brain.slug);
    return { ok: true as const, id: note.id };
  } catch (e) {
    if ((e as Error)?.message?.includes("another base")) {
      return { error: "Folder is in another base." };
    }
    throw e;
  }
}

export async function editSvodNoteAction(formData: FormData) {
  const found = await editableBrain(formData);
  if (!found) return { error: "Base not found." };
  const noteId = String(formData.get("noteId") ?? "");
  if (!isUuid(noteId)) return { error: "Note not found." };
  const titleV = validateNoteTitle(formData.get("title"));
  if (!titleV.ok) return { error: titleV.error };
  // The editor may submit LF-normalised text for an unchanged CRLF body:
  // updateSvodNote compares normalised and preserves the stored bytes
  // (including title-only edits); a true no-op keeps vectors and chunk IDs.
  const bodyV = validateNoteBody(formData.get("body"));
  if (!bodyV.ok) return { error: bodyV.error };
  const note = await updateSvodNote({
    brainId: found.brain.id,
    noteId,
    title: titleV.title,
    body: bodyV.body,
  });
  if (!note) return { error: "Note not found." };
  revalidateBrain(found.brain.id, found.brain.slug);
  return { ok: true as const, id: note.id };
}

export async function moveSvodNoteAction(formData: FormData) {
  const found = await editableBrain(formData);
  if (!found) return { error: "Base not found." };
  const noteId = String(formData.get("noteId") ?? "");
  if (!isUuid(noteId)) return { error: "Note not found." };
  const rawFolder = String(formData.get("folderId") ?? "").trim();
  const folderId = rawFolder || null;
  if (folderId && !isUuid(folderId)) return { error: "Folder is in another base." };
  try {
    const ok = await moveSvodNote({ brainId: found.brain.id, noteId, folderId });
    if (!ok) return { error: "Note not found." };
  } catch (e) {
    if ((e as Error)?.message?.includes("another base")) return { error: "Folder is in another base." };
    throw e;
  }
  revalidateBrain(found.brain.id, found.brain.slug);
  return { ok: true as const };
}

export async function deleteSvodNoteAction(formData: FormData): Promise<void> {
  const found = await editableBrain(formData);
  if (!found) return;
  const noteId = String(formData.get("noteId") ?? "");
  if (!isUuid(noteId)) return;
  await deleteSvodNote(found.brain.id, noteId);
  revalidateBrain(found.brain.id, found.brain.slug);
}

export async function uploadMdAction(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const brainId = String(formData.get("brainId") ?? formData.get("slug") ?? "");
  const access = await workspaceBrain(brainId, user.id);
  // Editors and above only; readers get the same "not found" as strangers.
  if (!access?.canEdit) return { error: "Base not found." };
  const rawFolder = String(formData.get("folderId") ?? "").trim();
  const folderId = rawFolder || null;
  if (folderId) {
    if (!isUuid(folderId)) return { error: "Folder is in another base." };
    const f = await folderInBrain(folderId, access.brain.id);
    if (!f) return { error: "Folder is in another base." };
  }
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Choose a .md file." };
  const name = (file.name || "").trim();
  // Extension-only gate: the MIME must not let a renamed PDF through.
  if (!/\.md$/i.test(name)) {
    return { error: "Only .md files — one file becomes one note." };
  }
  if (file.size > MAX_MD_UPLOAD_BYTES) {
    return { error: `File is too big (${Math.round(file.size / 1024)} KB, max ${MAX_MD_UPLOAD_BYTES / 1024} KB). Split it.` };
  }
  if (file.size === 0) return { error: "File is empty." };
  const buf = Buffer.from(await file.arrayBuffer());
  // Fatal UTF-8 with the BOM marker preserved (ignoreBOM) so the exact input
  // bytes round-trip through store → download.
  const decoded = decodeMdBytes(buf);
  if (!decoded.ok) return { error: decoded.error };
  const text = decoded.text;
  // Byte-preserving: no line-ending rewrite, no trim of the stored body.
  if (!text.replace(/\s/g, "")) return { error: "File is empty." };
  if (text.length > 100_000) {
    return { error: `Note is too long (${text.length} chars, max 100000). Split it.` };
  }
  if (text.includes("\0")) return { error: "Note cannot contain NUL bytes." };
  // Title: first Markdown heading, else the filename without extension.
  const heading = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^#{1,6}\s+\S/.test(l));
  const fromHeading = heading ? heading.replace(/^#{1,6}\s+/, "").trim().slice(0, 200) : "";
  const fromFile = name.replace(/\.md$/i, "").trim().slice(0, 200) || "Untitled";
  const titleV = validateNoteTitle(fromHeading || fromFile);
  if (!titleV.ok) return { error: titleV.error };
  try {
    const note = await createSvodNote({
      brainId: access.brain.id,
      folderId,
      title: titleV.title,
      body: text,
    });
    revalidateBrain(access.brain.id, access.brain.slug);
    return { ok: true as const, id: note.id, title: note.title };
  } catch (e) {
    if ((e as Error)?.message?.includes("another base")) return { error: "Folder is in another base." };
    throw e;
  }
}
