import { maybeOne, query } from "@/db";
import type { Folder } from "@/db/types";

/**
 * SVOD stage 3 folder helpers.
 *
 * Folders live inside one base (brains.id). Notes link optionally via
 * notes.folder_id; NULL means the base root. All same-base rules are enforced
 * twice: by the 0094 triggers (the database says no) and by the actions below
 * (the app says no before it gets there, with a readable error and a role
 * check first). A forged form carrying another base's folder/note ID resolves
 * its own base and is denied — never trusted from the form.
 */

export interface FolderNode {
  folder: Folder;
  children: FolderNode[];
  depth: number;
}

export interface NoteMeta {
  id: string;
  brain_id: string;
  folder_id: string | null;
  title: string;
  status: string;
  updated_at?: unknown;
  created_at: Date | string;
}

export function validateFolderName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const rawStr = String(raw ?? "");
  if (/[\n\r]/.test(rawStr)) return { ok: false, error: "Folder name cannot contain line breaks." };
  if (rawStr !== rawStr.trim()) return { ok: false, error: "Folder name cannot start or end with spaces." };
  const name = rawStr.trim();
  if (!name) return { ok: false, error: "Give the folder a name." };
  if (name.length > 120) return { ok: false, error: "Folder name is too long (max 120)." };
  if (name.includes("/")) return { ok: false, error: "Folder name cannot contain “/” — it separates the path." };
  if (name.includes("\\")) return { ok: false, error: "Folder name cannot contain “\\”." };
  if (name === "." || name === "..") return { ok: false, error: "That name is reserved." };
  return { ok: true, name };
}

/** Strict UUID check before SQL: malformed IDs are 404, never a 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** First value of a query param: repeated ?note= must not make .trim() throw. */
export function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export function validateBaseTitle(raw: unknown): { ok: true; title: string } | { ok: false; error: string } {
  const title = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!title) return { ok: false, error: "Give the base a name." };
  if (title.length > 80) return { ok: false, error: "Base name is too long (max 80)." };
  if (/[\n\r]/.test(title)) return { ok: false, error: "Base name cannot contain line breaks." };
  return { ok: true, title };
}

export async function listFolders(brainId: string): Promise<Folder[]> {
  return query<Folder>(
    `select * from folders where brain_id = $1 order by parent_id nulls first, name`,
    [brainId],
  );
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), f]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const walk = (parentId: string | null, depth: number): FolderNode[] =>
    (byParent.get(parentId) ?? []).map((folder) => ({
      folder,
      depth,
      children: walk(folder.id, depth + 1),
    }));
  return walk(null, 0);
}

/** folderId -> ancestor chain (root first). Used to expand the tree to a note. */
export function ancestorChain(
  folders: Folder[],
  folderId: string | null,
): Folder[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: Folder[] = [];
  let cur = byId.get(folderId) ?? null;
  let guard = 0;
  while (cur && guard++ < 100) {
    chain.unshift(cur);
    cur = cur.parent_id ? (byId.get(cur.parent_id) ?? null) : null;
  }
  return chain;
}

/** folderId -> "UI / Moon.Controls". Root (null) is "". */
export function folderPath(folders: Folder[], folderId: string | null): string {
  if (!folderId) return "";
  return ancestorChain(folders, folderId)
    .map((f) => f.name)
    .join(" / ");
}

/** Set of folder IDs that must render expanded to reveal `target`. */
export function expandedForNote(folders: Folder[], folderId: string | null): Set<string> {
  return new Set(ancestorChain(folders, folderId).map((f) => f.id));
}

/** Same-base guard used by every folder/note action: IDs, not form hints. */
export async function folderInBrain(folderId: string, brainId: string): Promise<Folder | null> {
  if (!isUuid(folderId) || !isUuid(brainId)) return null;
  const f = await maybeOne<Folder>(`select * from folders where id = $1 and brain_id = $2`, [
    folderId,
    brainId,
  ]);
  return f;
}

export async function noteInBrain(
  noteId: string,
  brainId: string,
): Promise<{ id: string; brain_id: string; folder_id: string | null } | null> {
  if (!isUuid(noteId) || !isUuid(brainId)) return null;
  const n = await maybeOne<{ id: string; brain_id: string; folder_id: string | null }>(
    `select id, brain_id, folder_id from notes where id = $1 and brain_id = $2`,
    [noteId, brainId],
  );
  return n;
}
