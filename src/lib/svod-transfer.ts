import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { crc32, zip } from "@/lib/zip";

/**
 * SVOD stage 6 transfer: full + markdown ZIP, reader, match plans.
 *
 * Pure (no DB, no storage, no embed) so unit tests run without Postgres.
 * DB commit lives in svod-import.ts and reuses the plans here.
 */

export const SVOD_FULL_FORMAT = "svod-full";
export const SVOD_FULL_VERSION = 1;

export const SVOD_REQUEST_MAX = 128 * 1024 * 1024;
export const SVOD_UNPACKED_MAX = 512 * 1024 * 1024;
export const SVOD_ENTRIES_MAX = 20_000;
export const SVOD_ENTRY_MAX = 32 * 1024 * 1024;
const SVOD_RATIO_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSvodUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Replace \ / : * ? " < > | and controls with _ (file + path segments). */
export function sanitizeSegment(s: string): string {
  return s.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, "_");
}

export class SvodArchiveError extends Error {}

// ─── zip reader (store + deflate, central dir + EOCD) ────────────────────────

export interface ParsedEntry {
  name: string;
  body: Buffer;
}

function readU16(b: Buffer, o: number): number {
  return b.readUInt16LE(o);
}
function readU32(b: Buffer, o: number): number {
  return b.readUInt32LE(o);
}

function decodeName(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SvodArchiveError("Archive has a non-UTF-8 name.");
  }
}

export function validateEntryName(name: string): void {
  if (name.includes("\0")) throw new SvodArchiveError("Archive has a forbidden path.");
  if (name.includes("\\")) throw new SvodArchiveError("Archive has a forbidden path.");
  if (name.startsWith("/")) throw new SvodArchiveError("Archive has a forbidden path.");
  if (/^[A-Za-z]:/.test(name)) throw new SvodArchiveError("Archive has a forbidden path.");
  const parts = name.split("/");
  for (const p of parts) {
    if (p === "..") throw new SvodArchiveError("Archive has a forbidden path.");
  }
}

function findEocd(buf: Buffer): number {
  const minSize = 22;
  if (buf.length < minSize) throw new SvodArchiveError("Archive is not a readable ZIP.");
  const searchStart = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  throw new SvodArchiveError("Archive is not a readable ZIP.");
}

/**
 * Parse a ZIP written by our store writer or by Obsidian/Git/Compress-Archive:
 * methods 0/8, UTF-8 flag + data descriptor (bit 3) via central directory.
 * Encrypted or unknown methods are archive errors. Limits reject the whole
 * archive before any write.
 */
export function parseZip(buf: Buffer): ParsedEntry[] {
  if (buf.length > SVOD_REQUEST_MAX + 1024 * 1024) {
    throw new SvodArchiveError("Archive is too large.");
  }
  const eocd = findEocd(buf);
  const count = readU16(buf, eocd + 10);
  const centralSize = readU32(buf, eocd + 12);
  const centralOff = readU32(buf, eocd + 16);
  if (count > SVOD_ENTRIES_MAX) throw new SvodArchiveError("Archive holds too many entries.");
  if (centralOff + centralSize > buf.length) throw new SvodArchiveError("Archive is not a readable ZIP.");
  // zip64 markers: unsupported.
  if (count === 0xffff || centralOff === 0xffffffff || centralSize === 0xffffffff) {
    throw new SvodArchiveError("Archive is not a readable ZIP.");
  }

  interface Central {
    flags: number;
    method: number;
    crc: number;
    compSize: number;
    uncompSize: number;
    name: string;
    localOff: number;
  }
  const centrals: Central[] = [];
  let p = centralOff;
  let totalUnpacked = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) throw new SvodArchiveError("Archive is not a readable ZIP.");
    if (readU32(buf, p) !== 0x02014b50) throw new SvodArchiveError("Archive is not a readable ZIP.");
    const flags = readU16(buf, p + 8);
    const method = readU16(buf, p + 10);
    const crc = readU32(buf, p + 16);
    const compSize = readU32(buf, p + 20);
    const uncompSize = readU32(buf, p + 24);
    const nameLen = readU16(buf, p + 28);
    const extraLen = readU16(buf, p + 30);
    const commentLen = readU16(buf, p + 32);
    const localOff = readU32(buf, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) {
      throw new SvodArchiveError("Archive is not a readable ZIP.");
    }
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen));
    validateEntryName(name);
    if (flags & 0x01) throw new SvodArchiveError("Archive is encrypted.");
    if (method !== 0 && method !== 8) throw new SvodArchiveError("Archive uses an unsupported method.");
    if (uncompSize > SVOD_ENTRY_MAX) throw new SvodArchiveError("Archive entry is too large.");
    // Directory entries (trailing /) carry no data.
    if (!name.endsWith("/")) {
      totalUnpacked += uncompSize;
      if (totalUnpacked > SVOD_UNPACKED_MAX) throw new SvodArchiveError("Archive unpacks too large.");
      if (uncompSize > compSize * SVOD_RATIO_MAX) throw new SvodArchiveError("Archive looks like a zip bomb.");
    }
    centrals.push({ flags, method, crc, compSize, uncompSize, name, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (centrals.length > SVOD_ENTRIES_MAX) throw new SvodArchiveError("Archive holds too many entries.");

  const out: ParsedEntry[] = [];
  for (const c of centrals) {
    if (c.name.endsWith("/")) continue;
    // Directories created implicitly by file paths have no central entry of
    // their own; entries with empty names are never useful.
    if (!c.name) continue;
    if (c.localOff + 30 > buf.length) throw new SvodArchiveError("Archive is not a readable ZIP.");
    if (readU32(buf, c.localOff) !== 0x04034b50) throw new SvodArchiveError("Archive is not a readable ZIP.");
    const localNameLen = readU16(buf, c.localOff + 26);
    const localExtraLen = readU16(buf, c.localOff + 28);
    const dataStart = c.localOff + 30 + localNameLen + localExtraLen;
    if (dataStart + c.compSize > buf.length) throw new SvodArchiveError("Archive is not a readable ZIP.");
    const comp = buf.subarray(dataStart, dataStart + c.compSize);
    let body: Buffer;
    if (c.method === 0) {
      if (comp.length !== c.uncompSize) throw new SvodArchiveError("Archive is not a readable ZIP.");
      body = Buffer.from(comp);
    } else {
      try {
        body = Buffer.from(inflateRawSync(comp));
      } catch {
        throw new SvodArchiveError("Archive is not a readable ZIP.");
      }
      if (body.length !== c.uncompSize) throw new SvodArchiveError("Archive is not a readable ZIP.");
      if (body.length > SVOD_ENTRY_MAX) throw new SvodArchiveError("Archive entry is too large.");
    }
    if ((crc32(body) >>> 0) !== (c.crc >>> 0)) throw new SvodArchiveError("Archive is corrupt.");
    out.push({ name: c.name, body });
  }
  return out;
}

// ─── full archive types ──────────────────────────────────────────────────────

export interface FullBrain {
  id: string;
  title: string;
  slug: string;
  goal: string | null;
  project_id: string | null;
  auto_index: boolean;
}
export interface FullFolder {
  id: string;
  parent_id: string | null;
  name: string;
}
export interface FullNote {
  id: string;
  folder_id: string | null;
  title: string;
  body: string;
  status: string;
  category: string | null;
  kind: string;
  author: string;
  revision: number;
  target_note_id: string | null;
  target_revision: number | null;
  proposed_by: string | null;
  token_id: string | null;
  token_label: string | null;
}
export interface FullSource {
  id: string;
  kind: string;
  original_name: string | null;
  mime: string | null;
  status: string;
  archive_path: string | null;
}
export interface FullChunk {
  id: string;
  note_id: string;
  content: string;
  token_count: number;
  input_hash: string | null;
  section_ordinal: number | null;
  embed_fingerprint: string | null;
  embed_state: string;
  embedding: number[] | null;
}
export interface FullArchiveData {
  format: string;
  version: number;
  brain: FullBrain;
  folders: FullFolder[];
  notes: FullNote[];
  sources: FullSource[];
  chunks: FullChunk[];
}

export type ArchiveKind = "full" | "markdown";

export interface ClassifiedArchive {
  kind: ArchiveKind;
  full: FullArchiveData | null;
  attachments: Map<string, Buffer>;
  mdFiles: { name: string; body: Buffer }[];
}

function parseFullJson(body: Buffer): FullArchiveData {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new SvodArchiveError("Archive is not a readable full export.");
  }
  // BOM must not be present: writer emits plain UTF-8.
  if (text.charCodeAt(0) === 0xfeff) throw new SvodArchiveError("Archive is not a readable full export.");
  let json: FullArchiveData;
  try {
    json = JSON.parse(text) as FullArchiveData;
  } catch {
    throw new SvodArchiveError("Archive is not a readable full export.");
  }
  if (json.format !== SVOD_FULL_FORMAT) throw new SvodArchiveError("Archive is not a Svod full export.");
  if (json.version !== SVOD_FULL_VERSION) throw new SvodArchiveError("Archive version is not supported.");
  if (!Array.isArray(json.folders) || !Array.isArray(json.notes) || !Array.isArray(json.sources) || !Array.isArray(json.chunks)) {
    throw new SvodArchiveError("Archive is not a readable full export.");
  }
  return json;
}

/** Classify parsed entries; throws SvodArchiveError on format errors. */
export function classifyEntries(entries: ParsedEntry[]): ClassifiedArchive {
  const fullEntry = entries.find((e) => e.name === "svod-full.json");
  if (fullEntry) {
    const full = parseFullJson(fullEntry.body);
    const attachments = new Map<string, Buffer>();
    for (const e of entries) {
      if (e.name === "svod-full.json") continue;
      if (e.name.startsWith("attachments/")) {
        attachments.set(e.name.slice("attachments/".length), e.body);
        continue;
      }
      // Forward-compatible: ignore unknown files in a full archive.
    }
    return { kind: "full", full, attachments, mdFiles: [] };
  }
  const mdFiles = entries.filter((e) => e.name.toLowerCase().endsWith(".md"));
  if (!mdFiles.length) throw new SvodArchiveError("Archive holds no importable notes.");
  return { kind: "markdown", full: null, attachments: new Map(), mdFiles };
}

export function classifyZipBuffer(buf: Buffer): ClassifiedArchive {
  return classifyEntries(parseZip(buf));
}

// ─── markdown filename + folder helpers ──────────────────────────────────────

export function exportFileStem(title: string): string {
  const base = sanitizeSegment(title);
  if (!base || base === "." || base === "..") return "Untitled";
  return base;
}

/** Folder id -> sanitized dir path ("" for root). */
export function folderDirPath(
  folders: { id: string; parent_id: string | null; name: string }[],
  folderId: string | null,
): string {
  if (!folderId) return "";
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: string[] = [];
  let cur = byId.get(folderId) ?? null;
  let guard = 0;
  while (cur && guard++ < 200) {
    chain.unshift(sanitizeSegment(cur.name) || "Untitled");
    cur = cur.parent_id ? (byId.get(cur.parent_id) ?? null) : null;
  }
  return chain.join("/");
}

export interface MdBuildNote {
  id: string;
  folder_id: string | null;
  title: string;
  body: string;
}

/** One .md per active note; collision suffix "-"+id8; empty folders omitted. */
export function markdownEntriesForNotes(
  notes: MdBuildNote[],
  folders: { id: string; parent_id: string | null; name: string }[],
): { name: string; body: Buffer }[] {
  const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set<string>();
  const out: { name: string; body: Buffer }[] = [];
  for (const n of sorted) {
    const dir = folderDirPath(folders, n.folder_id);
    const stem = exportFileStem(n.title);
    const filename = `${stem}.md`;
    let full = dir ? `${dir}/${filename}` : filename;
    if (used.has(full)) {
      const suffixed = `${stem}-${n.id.slice(0, 8)}.md`;
      full = dir ? `${dir}/${suffixed}` : suffixed;
      let counter = 2;
      while (used.has(full)) {
        const alt = `${stem}-${n.id.slice(0, 8)}-${counter}.md`;
        full = dir ? `${dir}/${alt}` : alt;
        counter += 1;
      }
    }
    used.add(full);
    out.push({ name: full, body: Buffer.from(n.body, "utf8") });
  }
  return out;
}

export function buildMarkdownZip(
  notes: MdBuildNote[],
  folders: { id: string; parent_id: string | null; name: string }[],
): Buffer {
  return zip(markdownEntriesForNotes(notes, folders));
}

// ─── full archive builder (export side) ──────────────────────────────────────

export interface FullBuildInput {
  brain: FullBrain;
  folders: FullFolder[];
  notes: FullNote[];
  sources: FullSource[];
  chunks: FullChunk[];
  attachments: { sourceId: string; body: Buffer }[];
}

export function buildFullArchiveData(input: FullBuildInput): FullArchiveData {
  return {
    format: SVOD_FULL_FORMAT,
    version: SVOD_FULL_VERSION,
    brain: input.brain,
    folders: input.folders,
    notes: input.notes,
    sources: input.sources,
    chunks: input.chunks,
  };
}

export function buildFullZip(input: FullBuildInput): Buffer {
  const data = buildFullArchiveData(input);
  const entries: { name: string; body: Buffer }[] = [
    { name: "svod-full.json", body: Buffer.from(JSON.stringify(data), "utf8") },
  ];
  for (const a of input.attachments) {
    entries.push({ name: `attachments/${a.sourceId}`, body: a.body });
  }
  return zip(entries);
}

// ─── match plans (pure) ──────────────────────────────────────────────────────

export interface PlanMatch {
  id: string;
  title: string;
  status: string;
  path: string;
}
export interface PlanAdd {
  id: string | null;
  title: string;
  status: string;
  path: string;
}
export interface PlanConflict {
  id: string;
  title: string;
  reason: string;
}

export interface FolderPlan {
  folderMap: Map<string, string>;
  foldersToCreate: { archiveId: string; targetId: string; parentTargetId: string | null; name: string }[];
  errors: string[];
}

/**
 * Map archive folders onto target folders by parent+name.
 * Free archive ids are kept; occupied ones get a fresh uuid.
 */
export function planFolders(
  archiveFolders: FullFolder[],
  targetFolders: { id: string; parent_id: string | null; name: string }[],
  globalFolderIds: Set<string>,
  newId?: () => string,
): FolderPlan {
  const gen = newId ?? randomUUID;
  const errors: string[] = [];
  const folderMap = new Map<string, string>();
  const foldersToCreate: FolderPlan["foldersToCreate"] = [];
  const byParentName = new Map<string, string>();
  for (const f of targetFolders) {
    byParentName.set(`${f.parent_id ?? ""}\n${f.name}`, f.id);
  }
  const usedTarget = new Set(targetFolders.map((f) => f.id));
  // Depth ordering: parents before children.
  const byId = new Map(archiveFolders.map((f) => [f.id, f]));
  const depth = (f: FullFolder): number => {
    let d = 0;
    let cur: FullFolder | undefined = f;
    let guard = 0;
    while (cur?.parent_id && guard++ < 500) {
      d += 1;
      cur = byId.get(cur.parent_id);
      if (!cur) break;
    }
    return d;
  };
  const ordered = [...archiveFolders].sort((a, b) => depth(a) - depth(b));
  for (const af of ordered) {
    let parentTarget: string | null = null;
    if (af.parent_id) {
      const mapped = folderMap.get(af.parent_id);
      if (!mapped) {
        errors.push(`Folder "${af.name}" has a missing parent; placed at root.`);
      } else {
        parentTarget = mapped;
      }
    }
    const key = `${parentTarget ?? ""}\n${af.name}`;
    const existing = byParentName.get(key);
    if (existing) {
      folderMap.set(af.id, existing);
      continue;
    }
    let targetId: string;
    if (!globalFolderIds.has(af.id) && !usedTarget.has(af.id)) {
      targetId = af.id;
    } else {
      targetId = gen();
    }
    folderMap.set(af.id, targetId);
    usedTarget.add(targetId);
    byParentName.set(key, targetId);
    foldersToCreate.push({ archiveId: af.id, targetId, parentTargetId: parentTarget, name: af.name });
  }
  return { folderMap, foldersToCreate, errors };
}

export interface FullPlan {
  adds: PlanAdd[];
  matches: PlanMatch[];
  conflicts: PlanConflict[];
  errors: string[];
  /** Archive active notes that are free and valid (insert candidates). */
  activeAdds: FullNote[];
  /** Archive pending notes that are free, valid and target-ok. */
  pendingAdds: FullNote[];
  /** Matched target rows (same id, same status) for update/skip. */
  matchedActive: { archive: FullNote; existingPath: string }[];
  matchedPending: { archive: FullNote; existingPath: string }[];
}

function noteDisplayPath(
  folderMap: Map<string, string>,
  folderPathByTarget: Map<string, string>,
  archiveFoldersById: Map<string, FullFolder>,
  folderId: string | null,
  title: string,
): string {
  let dir = "";
  if (folderId) {
    const targetId = folderMap.get(folderId);
    if (targetId) dir = folderPathByTarget.get(targetId) ?? "";
    else {
      // Fallback: archive chain names.
      const chain: string[] = [];
      let cur = archiveFoldersById.get(folderId) ?? null;
      let guard = 0;
      while (cur && guard++ < 200) {
        chain.unshift(cur.name);
        cur = cur.parent_id ? (archiveFoldersById.get(cur.parent_id) ?? null) : null;
      }
      dir = chain.join(" / ");
    }
  }
  return dir ? `${dir} / ${title}` : title;
}

export function planFullImport(opts: {
  archive: FullArchiveData;
  targetBrainId: string;
  targetFolders: { id: string; parent_id: string | null; name: string }[];
  targetNotesById: Map<string, { folder_id: string | null; title: string; body: string; status: string }>;
  globalNoteBrain: Map<string, string>;
  globalFolderIds: Set<string>;
  folderPlan?: FolderPlan;
}): FullPlan {
  const { archive, targetBrainId, targetNotesById, globalNoteBrain } = opts;
  const folderPlan =
    opts.folderPlan ?? planFolders(archive.folders, opts.targetFolders, opts.globalFolderIds);
  const adds: PlanAdd[] = [];
  const matches: PlanMatch[] = [];
  const conflicts: PlanConflict[] = [];
  const errors: string[] = [...folderPlan.errors];
  const activeAdds: FullNote[] = [];
  const pendingAdds: FullNote[] = [];
  const matchedActive: FullPlan["matchedActive"] = [];
  const matchedPending: FullPlan["matchedPending"] = [];

  // Target folder path labels for display (raw names, " / ").
  const targetById = new Map(opts.targetFolders.map((f) => [f.id, f]));
  // Include folders that will be created for display.
  for (const c of folderPlan.foldersToCreate) {
    targetById.set(c.targetId, {
      id: c.targetId,
      parent_id: c.parentTargetId,
      name: c.name,
    });
  }
  const folderPathByTarget = new Map<string, string>();
  const chainOf = (fid: string | null): string => {
    if (!fid) return "";
    const chain: string[] = [];
    let cur = targetById.get(fid) ?? null;
    let guard = 0;
    while (cur && guard++ < 200) {
      chain.unshift(cur.name);
      cur = cur.parent_id ? (targetById.get(cur.parent_id) ?? null) : null;
    }
    return chain.join(" / ");
  };
  for (const id of targetById.keys()) folderPathByTarget.set(id, chainOf(id));
  const archiveFoldersById = new Map(archive.folders.map((f) => [f.id, f]));

  const activeIds = new Set<string>();
  for (const n of archive.notes) {
    if (n.status === "active") activeIds.add(n.id);
  }

  for (const n of archive.notes) {
    if (n.status !== "active" && n.status !== "pending") {
      errors.push(`Note "${n.title}" has an unsupported status; skipped.`);
      continue;
    }
    if (typeof n.body !== "string" || n.body.includes("\0")) {
      errors.push(`Note "${n.title}" is unreadable; skipped.`);
      continue;
    }
    const owner = globalNoteBrain.get(n.id);
    if (owner && owner !== targetBrainId) {
      conflicts.push({ id: n.id, title: n.title, reason: "Note id belongs to another base." });
      continue;
    }
    const existing = targetNotesById.get(n.id);
    const display = noteDisplayPath(folderPlan.folderMap, folderPathByTarget, archiveFoldersById, n.folder_id, n.title);
    if (existing) {
      if (existing.status !== n.status) {
        conflicts.push({ id: n.id, title: n.title, reason: "Note id has a different status here." });
        continue;
      }
      matches.push({ id: n.id, title: n.title, status: n.status, path: display });
      if (n.status === "active") matchedActive.push({ archive: n, existingPath: display });
      else matchedPending.push({ archive: n, existingPath: display });
      continue;
    }
    // Free id: pending needs a live active target.
    if (n.status === "pending" && n.target_note_id) {
      const targetActive =
        targetNotesById.get(n.target_note_id)?.status === "active" || activeIds.has(n.target_note_id);
      // A target that is itself conflicted (owned elsewhere) is not live here.
      const targetOwner = globalNoteBrain.get(n.target_note_id);
      const targetLive =
        targetActive && (!targetOwner || targetOwner === targetBrainId);
      if (!targetLive) {
        errors.push(`Proposal "${n.title}" skips: its target is missing here.`);
        continue;
      }
    }
    adds.push({ id: n.id, title: n.title, status: n.status, path: display });
    if (n.status === "active") activeAdds.push(n);
    else pendingAdds.push(n);
  }
  return { adds, matches, conflicts, errors, activeAdds, pendingAdds, matchedActive, matchedPending };
}

// ─── markdown plan ───────────────────────────────────────────────────────────

export interface MdInputFile {
  name: string;
  body: string;
}

export interface MarkdownPlan {
  adds: PlanAdd[];
  matches: PlanMatch[];
  conflicts: PlanConflict[];
  errors: string[];
  /** Resolved operations for commit. */
  ops: {
    file: MdInputFile;
    dirParts: string[];
    stem: string;
    folderId: string | null;
    newFolderChain: string[];
    existingNoteId: string | null;
    title: string;
  }[];
  foldersToCreate: { path: string; name: string; parentId: string | null }[];
}

function splitMdPath(name: string): { dirParts: string[]; file: string } {
  const norm = name.replace(/\\/g, "/");
  const segs = norm.split("/");
  const file = segs.pop() ?? "";
  return { dirParts: segs.filter((s) => s !== ""), file };
}

export function planMarkdownImport(opts: {
  files: MdInputFile[];
  targetFolders: { id: string; parent_id: string | null; name: string }[];
  targetNotes: { id: string; folder_id: string | null; title: string; body: string }[];
}): MarkdownPlan {
  const adds: PlanAdd[] = [];
  const matches: PlanMatch[] = [];
  const conflicts: PlanConflict[] = [];
  const errors: string[] = [];
  const ops: MarkdownPlan["ops"] = [];

  // Sanitized folder path -> folder id (first wins on sanitize collision).
  const folderPathToId = new Map<string, string>();
  const byId = new Map(opts.targetFolders.map((f) => [f.id, f]));
  const sanPathOf = (fid: string | null): string => {
    if (!fid) return "";
    const chain: string[] = [];
    let cur = byId.get(fid) ?? null;
    let guard = 0;
    while (cur && guard++ < 200) {
      chain.unshift(sanitizeSegment(cur.name) || "Untitled");
      cur = cur.parent_id ? (byId.get(cur.parent_id) ?? null) : null;
    }
    return chain.join("/");
  };
  for (const f of opts.targetFolders) {
    const p = sanPathOf(f.id);
    if (!folderPathToId.has(p)) folderPathToId.set(p, f.id);
  }
  // Existing notes grouped by sanitized dir + sanitized base.
  interface ExNote {
    id: string;
    folder_id: string | null;
    title: string;
  }
  const byDirBase = new Map<string, ExNote[]>();
  for (const n of opts.targetNotes) {
    const dir = sanPathOf(n.folder_id);
    const base = sanitizeSegment(n.title) || "Untitled";
    const key = `${dir}\n${base}`;
    const list = byDirBase.get(key) ?? [];
    list.push({ id: n.id, folder_id: n.folder_id, title: n.title });
    byDirBase.set(key, list);
  }
  for (const list of byDirBase.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));

  const foldersToCreate: MarkdownPlan["foldersToCreate"] = [];
  const plannedDirs = new Set<string>(folderPathToId.keys());

  for (const f of opts.files) {
    try {
      validateEntryName(f.name);
    } catch {
      errors.push(`File "${f.name}" has a forbidden path; skipped.`);
      continue;
    }
    const { dirParts, file } = splitMdPath(f.name);
    if (!file.toLowerCase().endsWith(".md")) continue;
    const stemRaw = file.slice(0, -3);
    if (!stemRaw) {
      errors.push(`File "${f.name}" has no title; skipped.`);
      continue;
    }
    if (f.body.includes("\0")) {
      errors.push(`File "${f.name}" is unreadable; skipped.`);
      continue;
    }
    const dirSan = dirParts.map((s) => sanitizeSegment(s) || "Untitled");
    const dirKey = dirSan.join("/");
    // Plan folder creation for preview display.
    if (!plannedDirs.has(dirKey)) {
      let acc: string[] = [];
      for (const seg of dirSan) {
        acc = [...acc, seg];
        const key = acc.join("/");
        if (!plannedDirs.has(key)) {
          plannedDirs.add(key);
          const parentKey = acc.slice(0, -1).join("/");
          foldersToCreate.push({ path: key, name: acc[acc.length - 1], parentId: null });
          void parentKey;
        }
      }
    }
    // Suffix-aware match.
    const stemSan = sanitizeSegment(stemRaw) || "Untitled";
    const m = stemSan.match(/^(.*)-([0-9a-fA-F]{8})$/);
    const base = m ? m[1] : stemSan;
    const suffix = m ? m[2].toLowerCase() : null;
    const key = `${dirKey}\n${base}`;
    const candidates = byDirBase.get(key) ?? [];
    let existing: ExNote | null = null;
    if (suffix) {
      existing = candidates.find((c) => c.id.slice(0, 8).toLowerCase() === suffix) ?? null;
      if (!existing && candidates.length === 0) {
        // New note whose title legitimately ends with -XXXXXXXX.
      } else if (!existing) {
        // Suffix does not identify a note here: treat as new (full stem title).
        const fullKey = `${dirKey}\n${stemSan}`;
        const fullCands = byDirBase.get(fullKey) ?? [];
        if (fullCands.length === 1) existing = fullCands[0];
      }
    } else {
      if (candidates.length === 1) existing = candidates[0];
      else if (candidates.length > 1) existing = candidates[0];
    }
    const displayPath = dirParts.length ? `${dirParts.join(" / ")} / ${stemRaw}` : stemRaw;
    if (existing) {
      matches.push({ id: existing.id, title: existing.title, status: "active", path: displayPath });
      ops.push({
        file: f,
        dirParts,
        stem: stemRaw,
        folderId: existing.folder_id,
        newFolderChain: [],
        existingNoteId: existing.id,
        // Suffix only disambiguates files: the stored title stays exact.
        title: existing.title,
      });
    } else {
      adds.push({ id: null, title: stemRaw, status: "active", path: displayPath });
      ops.push({
        file: f,
        dirParts,
        stem: stemRaw,
        folderId: null,
        newFolderChain: dirSan,
        existingNoteId: null,
        title: stemRaw,
      });
    }
  }
  void conflicts;
  return { adds, matches, conflicts, errors, ops, foldersToCreate };
}

/** Decode one .md upload buffer byte-exactly (BOM kept, fatal UTF-8). */
export function decodeMdBytesStrict(buf: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    return { ok: true, text };
  } catch {
    return { ok: false, error: "Could not read the file as UTF-8." };
  }
}
