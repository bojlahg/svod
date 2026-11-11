import { randomUUID } from "node:crypto";
import { query, tx, toVector } from "@/db";
import type { PoolClient } from "pg";
import { syncSvodSections } from "@/lib/svod-index";
import { storage, storageKey } from "@/lib/storage";
import {
  planFolders,
  planFullImport,
  type FullArchiveData,
  type FullNote,
} from "@/lib/svod-transfer";
import { env } from "@/lib/env";

/**
 * SVOD stage 6 commit: one transaction per import.
 * Preview lives in the routes (read-only queries + pure plans here).
 * Export fetch also lives here so the route stays thin.
 */

const VALID_KINDS = new Set(["fact", "rule", "layout", "example", "pitfall"]);
const VALID_AUTHORS = new Set(["ingest", "human", "agent", "consolidated"]);
const VALID_SOURCE_KINDS = new Set(["image", "text", "url", "file", "site", "repo"]);

function cleanKind(k: unknown): string {
  return typeof k === "string" && VALID_KINDS.has(k) ? k : "fact";
}
function cleanAuthor(a: unknown): string {
  return typeof a === "string" && VALID_AUTHORS.has(a) ? a : "human";
}
function cleanRevision(r: unknown): number {
  return Number.isInteger(r) && (r as number) >= 1 ? (r as number) : 1;
}

export interface ExportFetch {
  brain: {
    id: string;
    title: string;
    slug: string;
    goal: string | null;
    project_id: string | null;
    auto_index: boolean;
  };
  folders: { id: string; parent_id: string | null; name: string }[];
  notes: FullNote[];
  sources: {
    id: string;
    kind: string;
    original_name: string | null;
    mime: string | null;
    status: string;
    archive_path: string | null;
  }[];
  chunks: {
    id: string;
    note_id: string;
    content: string;
    token_count: number;
    input_hash: string | null;
    section_ordinal: number | null;
    embed_fingerprint: string | null;
    embed_state: string;
    embedding: number[] | null;
  }[];
  attachments: { sourceId: string; body: Buffer }[];
}

function parseVectorText(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const arr = v as unknown[];
    if (!arr.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    return arr as number[];
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s.toLowerCase() === "null") return null;
    const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
    if (!inner.trim()) return null;
    const parts = inner.split(",");
    const out: number[] = [];
    for (const p of parts) {
      const n = Number(p.trim());
      if (!Number.isFinite(n)) return null;
      out.push(n);
    }
    return out;
  }
  return null;
}

export async function fetchFullExport(brainId: string, canReview: boolean): Promise<ExportFetch> {
  const brains = await query<{
    id: string;
    title: string;
    slug: string;
    goal: string | null;
    project_id: string | null;
    auto_index: boolean;
  }>(`select id, title, slug, goal, project_id, auto_index from brains where id = $1`, [brainId]);
  const brain = brains[0];
  if (!brain) throw new Error("Base not found.");
  const folders = await query<{ id: string; parent_id: string | null; name: string }>(
    `select id, parent_id, name from folders where brain_id = $1`,
    [brainId],
  );
  const notes = await query<FullNote & { token_prefix: string | null; token_name: string | null }>(
    `select n.id, n.folder_id, n.title, n.body, n.status, n.category, n.kind, n.author,
            n.revision, n.target_note_id, n.target_revision, n.proposed_by, n.token_id,
            tok.name as token_name, tok.prefix as token_prefix
       from notes n left join mcp_tokens tok on tok.id = n.token_id
      where n.brain_id = $1 and n.status in ('active', 'pending')`,
    [brainId],
  );
  const filtered = notes.filter((n) => (n.status === "pending" ? canReview : true));
  const fullNotes: FullNote[] = filtered.map((n) => ({
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
    token_label: n.token_name ?? n.token_prefix ?? null,
  }));
  const activeIds = new Set(fullNotes.filter((n) => n.status === "active").map((n) => n.id));
  let chunks: ExportFetch["chunks"] = [];
  if (activeIds.size) {
    const rows = await query<{
      id: string;
      note_id: string;
      content: string;
      token_count: number;
      input_hash: string | null;
      section_ordinal: number | null;
      embed_fingerprint: string | null;
      embed_state: string;
      embedding: unknown;
    }>(
      `select id, note_id, content, token_count, input_hash, section_ordinal,
              embed_fingerprint, embed_state, embedding::text as embedding
         from chunks where brain_id = $1`,
      [brainId],
    );
    chunks = rows
      .filter((c) => activeIds.has(c.note_id))
      .map((c) => ({
        id: c.id,
        note_id: c.note_id,
        content: c.content,
        token_count: c.token_count,
        input_hash: c.input_hash,
        section_ordinal: c.section_ordinal,
        embed_fingerprint: c.embed_fingerprint,
        embed_state: c.embed_state,
        embedding: parseVectorText(c.embedding),
      }));
  }
  const sources = await query<{
    id: string;
    kind: string;
    original_name: string | null;
    mime: string | null;
    status: string;
    storage_key: string | null;
  }>(
    `select id, kind, original_name, mime, status, storage_key from sources where brain_id = $1`,
    [brainId],
  );
  const outSources: ExportFetch["sources"] = [];
  const attachments: ExportFetch["attachments"] = [];
  for (const s of sources) {
    if (s.storage_key) {
      try {
        const body = await storage.get(s.storage_key);
        attachments.push({ sourceId: s.id, body });
        outSources.push({
          id: s.id,
          kind: s.kind,
          original_name: s.original_name,
          mime: s.mime,
          status: s.status,
          archive_path: `attachments/${s.id}`,
        });
        continue;
      } catch {
        // Broken attachment: row with null path, export continues.
      }
    }
    outSources.push({
      id: s.id,
      kind: s.kind,
      original_name: s.original_name,
      mime: s.mime,
      status: s.status,
      archive_path: null,
    });
  }
  return {
    brain: {
      id: brain.id,
      title: brain.title,
      slug: brain.slug,
      goal: brain.goal,
      project_id: brain.project_id,
      auto_index: brain.auto_index === true,
    },
    folders,
    notes: fullNotes,
    sources: outSources,
    chunks,
    attachments,
  };
}

// ─── commit: full ────────────────────────────────────────────────────────────

async function tokenExists(client: PoolClient, id: string | null): Promise<boolean> {
  if (!id) return false;
  try {
    const r = await client.query(`select id from mcp_tokens where id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function userExists(client: PoolClient, id: string | null): Promise<boolean> {
  if (!id) return false;
  try {
    const r = await client.query(`select id from "user" where id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function restoreVectorsForNote(
  client: PoolClient,
  brainId: string,
  noteId: string,
  archiveChunks: { input_hash: string | null; embed_fingerprint: string | null; embedding: number[] | null }[],
  embedUsable: boolean,
  embedFp: string | null,
): Promise<void> {
  const validByHash = new Map<string, { fp: string | null; vec: number[] }>();
  const dim = env.EMBED_DIM;
  for (const c of archiveChunks) {
    if (!c.input_hash || !c.embedding || !Array.isArray(c.embedding)) continue;
    if (c.embedding.length !== dim) continue;
    if (!c.embedding.every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    if (!validByHash.has(c.input_hash)) validByHash.set(c.input_hash, { fp: c.embed_fingerprint ?? null, vec: c.embedding });
  }
  if (!validByHash.size) return;
  let current: { id: string; input_hash: string | null }[] = [];
  try {
    const r = await client.query<{ id: string; input_hash: string | null }>(
      `select id, input_hash from chunks where note_id = $1`,
      [noteId],
    );
    current = r.rows;
  } catch {
    return;
  }
  for (const row of current) {
    if (!row.input_hash) continue;
    const arch = validByHash.get(row.input_hash);
    if (!arch) continue;
    let write = false;
    if (embedUsable && embedFp) {
      write = arch.fp === embedFp;
    } else if (!embedUsable) {
      write = true;
    } else {
      write = false;
    }
    if (!write) continue;
    try {
      await client.query(
        `update chunks set embedding = $2::halfvec, embed_fingerprint = $3, embed_state = 'ready', embed_error = null
          where id = $1 and input_hash = $4`,
        [row.id, toVector(arch.vec), arch.fp, row.input_hash],
      );
      await client.query(`delete from svod_embed_outbox where chunk_id = $1`, [row.id]).catch(() => {});
    } catch {
      // One bad vector never fails the import; the pending row stays queued.
    }
  }
  void brainId;
}

export async function commitFullImport(opts: {
  brainId: string;
  archive: FullArchiveData;
  attachments: Map<string, Buffer>;
  decision: "update" | "skip";
}): Promise<{ added: number; updated: number; skipped: number; conflicts: number; errors: string[] }> {
  const { brainId, archive, attachments, decision } = opts;
  return tx(async (client) => {
    await client.query(`select id from brains where id = $1 for update`, [brainId]);
    const targetFolders = (
      await client.query<{ id: string; parent_id: string | null; name: string }>(
        `select id, parent_id, name from folders where brain_id = $1`,
        [brainId],
      )
    ).rows;
    const targetNotes = (
      await client.query<{ id: string; folder_id: string | null; title: string; body: string; status: string; category: string | null; kind: string; target_note_id: string | null; target_revision: number | null }>(
        `select id, folder_id, title, body, status, category, kind, target_note_id, target_revision from notes where brain_id = $1`,
        [brainId],
      )
    ).rows;
    const targetById = new Map(targetNotes.map((n) => [n.id, n]));
    // Global id maps for conflict detection.
    const globalNoteBrain = new Map<string, string>();
    for (const n of archive.notes) {
      try {
        const r = await client.query<{ brain_id: string }>(`select brain_id from notes where id = $1`, [n.id]);
        if (r.rows[0]) globalNoteBrain.set(n.id, r.rows[0].brain_id);
      } catch {
        // stubbed pool without this shape: treat as free.
      }
    }
    const globalFolderIds = new Set<string>();
    for (const f of archive.folders) {
      try {
        const r = await client.query(`select id from folders where id = $1`, [f.id]);
        if ((r.rowCount ?? 0) > 0) globalFolderIds.add(f.id);
      } catch {
        // treat as free on stub
      }
    }
    const folderPlan = planFolders(archive.folders, targetFolders, globalFolderIds);
    // Create missing folders.
    for (const c of folderPlan.foldersToCreate) {
      try {
        await client.query(`insert into folders (id, brain_id, parent_id, name) values ($1, $2, $3, $4)`, [
          c.targetId,
          brainId,
          c.parentTargetId,
          c.name,
        ]);
      } catch (e) {
        // Unique race (concurrent import): resolve to the winner.
        const win = await client
          .query<{ id: string }>(`select id from folders where brain_id = $1 and coalesce(parent_id::text,'') = coalesce($2::text,'') and name = $3`, [
            brainId,
            c.parentTargetId,
            c.name,
          ])
          .catch(() => ({ rows: [] as { id: string }[] }));
        if (win.rows[0]) folderPlan.folderMap.set(c.archiveId, win.rows[0].id);
        else throw e;
      }
      // Keep local target list current for path display (not strictly needed).
      targetFolders.push({ id: c.targetId, parent_id: c.parentTargetId, name: c.name });
    }

    const plan = planFullImport({
      archive,
      targetBrainId: brainId,
      targetFolders,
      targetNotesById: targetById,
      globalNoteBrain,
      globalFolderIds,
      folderPlan,
    });

    let added = 0;
    let updated = 0;
    // Only real content writes mark the base changed: folder-only moves and
    // pure skips never touch content_changed_at (it feeds paid exams).
    let touched = false;
    const errors: string[] = [...plan.errors];

    // Embed state once for the whole import.
    let embedUsable = false;
    let embedFp: string | null = null;
    try {
      const { getSvodEmbedState } = await import("@/lib/embed");
      const st = await getSvodEmbedState();
      embedUsable = st.usable === true;
      embedFp = st.fingerprintId ?? null;
    } catch {
      embedUsable = false;
    }

    const chunksByNote = new Map<string, typeof archive.chunks>();
    for (const c of archive.chunks) {
      const list = chunksByNote.get(c.note_id) ?? [];
      list.push(c);
      chunksByNote.set(c.note_id, list);
    }

    // Active adds first (so proposals can point at them). Unexpected write
    // failures throw out of tx so Postgres rolls the whole import back.
    for (const n of plan.activeAdds) {
      const folderTarget = n.folder_id ? (folderPlan.folderMap.get(n.folder_id) ?? null) : null;
      const keepToken = n.token_id && (await tokenExists(client, n.token_id)) ? n.token_id : null;
      const keepProposed = n.proposed_by && (await userExists(client, n.proposed_by)) ? n.proposed_by : null;
      await client.query(
        `insert into notes (id, brain_id, folder_id, title, body, status, category, kind, author, revision, proposed_by, token_id, updated_token_id)
         values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$11)`,
        [
          n.id,
          brainId,
          folderTarget,
          n.title,
          n.body,
          n.category ?? null,
          cleanKind(n.kind),
          cleanAuthor(n.author),
          cleanRevision(n.revision),
          keepProposed,
          keepToken,
        ],
      );
      added += 1;
      touched = true;
      targetById.set(n.id, { id: n.id, folder_id: folderTarget, title: n.title, body: n.body, status: "active", category: n.category ?? null, kind: cleanKind(n.kind), target_note_id: null, target_revision: null });
      await syncSvodSections(client, { brainId, noteId: n.id, title: n.title, body: n.body });
      await restoreVectorsForNote(client, brainId, n.id, (chunksByNote.get(n.id) ?? []) as never, embedUsable, embedFp);
    }

    // Active matches.
    if (decision === "update") {
      for (const m of plan.matchedActive) {
        const cur = targetById.get(m.archive.id);
        if (!cur) continue;
        const folderTarget = m.archive.folder_id ? (folderPlan.folderMap.get(m.archive.folder_id) ?? null) : null;
        const same =
          cur.title === m.archive.title &&
          cur.body === m.archive.body &&
          (cur.folder_id ?? null) === folderTarget &&
          (cur.category ?? null) === (m.archive.category ?? null) &&
          cur.kind === cleanKind(m.archive.kind);
        if (same) continue;
        const contentChanged = cur.title !== m.archive.title || cur.body !== m.archive.body;
        if (contentChanged) {
          await client.query(
            `update notes set title=$2, body=$3, folder_id=$4, category=$5, kind=$6 where id=$1 and brain_id=$7`,
            [m.archive.id, m.archive.title, m.archive.body, folderTarget, m.archive.category ?? null, cleanKind(m.archive.kind), brainId],
          );
          await syncSvodSections(client, { brainId, noteId: m.archive.id, title: m.archive.title, body: m.archive.body });
          await restoreVectorsForNote(client, brainId, m.archive.id, (chunksByNote.get(m.archive.id) ?? []) as never, embedUsable, embedFp);
          touched = true;
        } else {
          await client.query(`update notes set folder_id=$2, category=$3, kind=$4 where id=$1 and brain_id=$5`, [
            m.archive.id,
            folderTarget,
            m.archive.category ?? null,
            cleanKind(m.archive.kind),
            brainId,
          ]);
        }
        updated += 1;
        targetById.set(m.archive.id, {
          id: m.archive.id,
          folder_id: folderTarget,
          title: m.archive.title,
          body: m.archive.body,
          status: "active",
          category: m.archive.category ?? null,
          kind: cleanKind(m.archive.kind),
          target_note_id: cur.target_note_id ?? null,
          target_revision: cur.target_revision ?? null,
        });
      }
    }

    // Pending adds (proposals) after actives so targets are live.
    for (const n of plan.pendingAdds) {
      const folderTarget = n.folder_id ? (folderPlan.folderMap.get(n.folder_id) ?? null) : null;
      const keepToken = n.token_id && (await tokenExists(client, n.token_id)) ? n.token_id : null;
      const keepProposed = n.proposed_by && (await userExists(client, n.proposed_by)) ? n.proposed_by : null;
      let targetRev: number | null = null;
      if (n.target_note_id) {
        const r = await client.query<{ revision: number }>(
          `select revision from notes where id = $1 and brain_id = $2 and status = 'active'`,
          [n.target_note_id, brainId],
        );
        if (!r.rows[0]) {
          errors.push(`Proposal "${n.title}" skips: its target is missing here.`);
          continue;
        }
        targetRev = r.rows[0].revision;
      }
      await client.query(
        `insert into notes (id, brain_id, folder_id, title, body, status, category, kind, author, revision, proposed_by, token_id, target_note_id, target_revision)
         values ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          n.id,
          brainId,
          folderTarget,
          n.title,
          n.body,
          n.category ?? null,
          cleanKind(n.kind),
          cleanAuthor(n.author),
          cleanRevision(n.revision),
          keepProposed,
          keepToken,
          n.target_note_id,
          targetRev,
        ],
      );
      added += 1;
      touched = true;
      targetById.set(n.id, { id: n.id, folder_id: folderTarget, title: n.title, body: n.body, status: "pending", category: n.category ?? null, kind: cleanKind(n.kind), target_note_id: n.target_note_id, target_revision: targetRev });
    }

    // Pending matches. A fully identical proposal (title, body, folder, target
    // and live target_revision) is a no-op with no UPDATE at all, so the
    // revision trigger never fires and reviewers see no phantom conflict.
    if (decision === "update") {
      for (const m of plan.matchedPending) {
        const cur = targetById.get(m.archive.id);
        if (!cur) continue;
        const folderTarget = m.archive.folder_id ? (folderPlan.folderMap.get(m.archive.folder_id) ?? null) : null;
        const liveTargetId = m.archive.target_note_id ?? null;
        let liveRev: number | null = null;
        if (liveTargetId) {
          const r = await client.query<{ revision: number }>(
            `select revision from notes where id = $1 and brain_id = $2 and status = 'active'`,
            [liveTargetId, brainId],
          );
          if (!r.rows[0]) {
            errors.push(`Proposal "${m.archive.title}" skips: its target is missing here.`);
            continue;
          }
          liveRev = r.rows[0].revision;
        }
        const same =
          cur.title === m.archive.title &&
          cur.body === m.archive.body &&
          (cur.folder_id ?? null) === folderTarget &&
          (cur.target_note_id ?? null) === liveTargetId &&
          (cur.target_revision ?? null) === liveRev;
        if (same) continue;
        const keepToken = m.archive.token_id && (await tokenExists(client, m.archive.token_id)) ? m.archive.token_id : null;
        const keepProposed = m.archive.proposed_by && (await userExists(client, m.archive.proposed_by)) ? m.archive.proposed_by : null;
        await client.query(
          `update notes set title=$2, body=$3, folder_id=$4, category=$5, kind=$6, proposed_by=$7, token_id=$8, target_note_id=$9, target_revision=$10
            where id=$1 and brain_id=$11 and status='pending'`,
          [
            m.archive.id,
            m.archive.title,
            m.archive.body,
            folderTarget,
            m.archive.category ?? null,
            cleanKind(m.archive.kind),
            keepProposed,
            keepToken,
            liveTargetId,
            liveRev,
            brainId,
          ],
        );
        updated += 1;
        if (cur.title !== m.archive.title || cur.body !== m.archive.body) touched = true;
        targetById.set(m.archive.id, {
          id: m.archive.id,
          folder_id: folderTarget,
          title: m.archive.title,
          body: m.archive.body,
          status: "pending",
          category: m.archive.category ?? null,
          kind: cleanKind(m.archive.kind),
          target_note_id: liveTargetId,
          target_revision: liveRev,
        });
      }
    }

    // Sources + attachments (never fail the whole import on one file).
    const globalSourceIds = new Set<string>();
    for (const s of archive.sources) {
      try {
        const r = await client.query(`select id from sources where id = $1`, [s.id]);
        if ((r.rowCount ?? 0) > 0) globalSourceIds.add(s.id);
      } catch {}
    }
    for (const s of archive.sources) {
      if (!VALID_SOURCE_KINDS.has(s.kind)) {
        errors.push(`Source "${s.original_name ?? s.id}" has an unsupported kind; skipped.`);
        continue;
      }
      let useId = s.id;
      if (globalSourceIds.has(s.id)) {
        // Owned elsewhere or already here: check if it is ours.
        try {
          const r = await client.query<{ brain_id: string }>(`select brain_id from sources where id = $1`, [s.id]);
          if (r.rows[0] && r.rows[0].brain_id !== brainId) useId = randomUUID();
          else if (r.rows[0]) continue; // already ours: keep.
        } catch {
          useId = randomUUID();
        }
      }
      const raw = attachments.get(s.id) ?? null;
      let storageKeyNew: string | null = null;
      let bytes: number | null = null;
      if (raw) {
        try {
          storageKeyNew = storageKey(brainId, s.original_name || "attachment.bin");
          await storage.put(storageKeyNew, raw, s.mime || "application/octet-stream");
          bytes = raw.length;
        } catch {
          storageKeyNew = null;
          bytes = null;
        }
      }
      await client.query(
        `insert into sources (id, brain_id, kind, storage_key, original_name, mime, bytes, status)
         values ($1,$2,$3,$4,$5,$6,$7,'ready')
         on conflict (id) do nothing`,
        [useId, brainId, s.kind, storageKeyNew, s.original_name, s.mime, bytes],
      );
    }

    if (touched) {
      await client.query(`update brains set content_changed_at = now() where id = $1`, [brainId]);
    }
    return { added, updated, skipped: plan.matches.length - updated, conflicts: plan.conflicts.length, errors };
  });
}

// ─── commit: markdown ────────────────────────────────────────────────────────

export async function commitMarkdownImport(opts: {
  brainId: string;
  files: { name: string; body: string }[];
  decision: "update" | "skip";
}): Promise<{ added: number; updated: number; skipped: number; conflicts: number; errors: string[] }> {
  const { brainId, files, decision } = opts;
  return tx(async (client) => {
    await client.query(`select id from brains where id = $1 for update`, [brainId]);
    const targetFolders = (
      await client.query<{ id: string; parent_id: string | null; name: string }>(
        `select id, parent_id, name from folders where brain_id = $1`,
        [brainId],
      )
    ).rows;
    const targetNotes = (
      await client.query<{ id: string; folder_id: string | null; title: string; body: string }>(
        `select id, folder_id, title, body from notes where brain_id = $1 and status = 'active'`,
        [brainId],
      )
    ).rows;

    const { planMarkdownImport } = await import("@/lib/svod-transfer");
    const plan = planMarkdownImport({ files, targetFolders, targetNotes });
    const errors: string[] = [...plan.errors];
    let added = 0;
    let updated = 0;

    // Resolve/create folder chains inside the tx.
    const folderByParentName = new Map<string, string>();
    for (const f of targetFolders) folderByParentName.set(`${f.parent_id ?? ""}\n${f.name}`, f.id);
    const resolveDir = async (dirParts: string[]): Promise<string | null> => {
      let parent: string | null = null;
      for (const rawSeg of dirParts) {
        // dirParts from plan are raw segments; folder names keep raw text.
        const seg: string = rawSeg;
        if (!seg || seg === "." || seg === "..") continue;
        const folderKey: string = `${parent ?? ""}\n${seg}`;
        let folderId: string | null = folderByParentName.get(folderKey) ?? null;
        // Sanitized collision: match an existing folder whose sanitized name equals.
        if (!folderId) {
          const { sanitizeSegment: san } = await import("@/lib/svod-transfer");
          for (const f of targetFolders) {
            if ((f.parent_id ?? null) === parent && san(f.name) === san(seg)) {
              folderId = f.id;
              folderByParentName.set(folderKey, folderId);
              break;
            }
          }
        }
        if (!folderId) {
          const nid: string = randomUUID();
          try {
            await client.query(`insert into folders (id, brain_id, parent_id, name) values ($1,$2,$3,$4)`, [
              nid,
              brainId,
              parent,
              seg.slice(0, 120),
            ]);
            folderId = nid;
          } catch {
            const winRows: { rows: { id: string }[] } = await client
              .query<{ id: string }>(
                `select id from folders where brain_id = $1 and coalesce(parent_id::text,'') = coalesce($2::text,'') and name = $3`,
                [brainId, parent, seg.slice(0, 120)],
              )
              .catch(() => ({ rows: [] as { id: string }[] }));
            if (!winRows.rows[0]) throw new Error(`Folder "${seg}" not saved.`);
            folderId = winRows.rows[0].id;
          }
          const createdId: string = folderId ?? nid;
          targetFolders.push({ id: createdId, parent_id: parent, name: seg.slice(0, 120) });
          folderByParentName.set(folderKey, createdId);
          parent = createdId;
        } else {
          parent = folderId;
        }
      }
      return parent;
    };

    const normForCompare = (s: string): string => s.replace(/\r\n?/g, "\n");
    let skipped = 0;
    let touched = false;
    for (const op of plan.ops) {
      if (op.existingNoteId) {
        const cur = targetNotes.find((n) => n.id === op.existingNoteId);
        if (!cur) continue;
        if (decision === "skip") {
          skipped += 1;
          continue;
        }
        // The stored title stays exact: the file suffix only disambiguates.
        const targetFolder = await resolveDir(op.dirParts);
        const sameBody = normForCompare(cur.body) === normForCompare(op.file.body);
        const sameFolder = (cur.folder_id ?? null) === (targetFolder ?? null);
        if (sameBody && sameFolder) {
          skipped += 1;
          continue;
        }
        // Preserve stored bytes when only newline-normalized.
        const nextBody = sameBody ? cur.body : op.file.body;
        if (sameBody) {
          await client.query(`update notes set folder_id=$2 where id=$1 and brain_id=$3`, [
            cur.id,
            targetFolder,
            brainId,
          ]);
        } else {
          await client.query(`update notes set body=$2, folder_id=$3 where id=$1 and brain_id=$4 and status='active'`, [
            cur.id,
            nextBody,
            targetFolder,
            brainId,
          ]);
          await syncSvodSections(client, { brainId, noteId: cur.id, title: cur.title, body: nextBody });
          touched = true;
        }
        updated += 1;
      } else {
        const newFolderId = await resolveDir(op.dirParts);
        const title = op.title.trim().replace(/\s+/g, " ").slice(0, 200) || "Untitled";
        if (!title) {
          errors.push(`File "${op.file.name}" has no title; skipped.`);
          continue;
        }
        const nid = randomUUID();
        await client.query(
          `insert into notes (id, brain_id, folder_id, title, body, status, author) values ($1,$2,$3,$4,$5,'active','human')`,
          [nid, brainId, newFolderId, title, op.file.body],
        );
        added += 1;
        touched = true;
        // Empty bodies yield no sections (stage 5 rule).
        if (op.file.body.replace(/\s/g, "")) {
          await syncSvodSections(client, { brainId, noteId: nid, title, body: op.file.body });
        }
      }
    }
    if (touched) {
      await client.query(`update brains set content_changed_at = now() where id = $1`, [brainId]);
    }
    return { added, updated, skipped, conflicts: 0, errors };
  });
}
