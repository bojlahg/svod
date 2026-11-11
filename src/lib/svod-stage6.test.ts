import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { stubDb } from "./test-db";
import { crc32, zip } from "./zip";
import {
  SvodArchiveError,
  buildFullZip,
  buildMarkdownZip,
  classifyEntries,
  exportFileStem,
  markdownEntriesForNotes,
  parseZip,
  planFullImport,
  planMarkdownImport,
  sanitizeSegment,
} from "./svod-transfer";

/**
 * SVOD stage 6: full + markdown transfer, reader, preview, vectors.
 * Pure + stubDb (no mandatory Postgres). Live Postgres only with
 * SVOD_TEST_DATABASE_URL, otherwise skipped.
 */

const BRAIN = "22222222-2222-4222-8222-222222222222";
const F1 = "33333333-3333-4333-8333-333333333333";
const F2 = "44444444-4444-4334-8444-444444444444";
const N1 = "55555555-5555-4555-8555-555555555555";
const P1 = "66666666-6666-4666-8666-666666666666";
const S1 = "77777777-7777-4777-8777-777777777777";
const OTHER_BRAIN = "88888888-8888-4888-8888-888888888888";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeDeflateZip(entries: { name: string; body: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const comp = deflateRawSync(e.body);
    const crc = crc32(e.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, comp);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(comp.length, 20);
    dir.writeUInt32LE(e.body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + comp.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBytes, end]);
}

// ─── full round-trip ────────────────────────────────────────────────────────

test("full round-trip keeps BOM/CR/CRLF/space, folders, ids, proposal, bytes", () => {
  const body = "﻿# Note\rLine one\rline two\r\nTail with space \n";
  assert.ok(body.includes("﻿") && body.includes("\r") && body.includes("\r\n"));
  const data = {
    brain: { id: BRAIN, title: "B", slug: "b", goal: null, project_id: null, auto_index: false },
    folders: [
      { id: F1, parent_id: null, name: "Guides" },
      { id: F2, parent_id: F1, name: "UI" },
    ],
    notes: [
      {
        id: N1, folder_id: F2, title: "Note", body, status: "active",
        category: null, kind: "fact", author: "human", revision: 2,
        target_note_id: null, target_revision: null, proposed_by: null, token_id: null, token_label: null,
      },
      {
        id: P1, folder_id: F2, title: "Proposal", body: "new body", status: "pending",
        category: null, kind: "rule", author: "agent", revision: 1,
        target_note_id: N1, target_revision: 2, proposed_by: "user-1", token_id: null, token_label: "tok-label",
      },
    ],
    sources: [{ id: S1, kind: "file", original_name: "a.bin", mime: "application/octet-stream", status: "ready", archive_path: `attachments/${S1}` }],
    chunks: [{
      id: "99999999-9999-4999-8999-999999999999", note_id: N1, content: "Note\n\nslice",
      token_count: 5, input_hash: "abc", section_ordinal: 0,
      embed_fingerprint: "fp-1", embed_state: "ready", embedding: [0.1, 0.2],
    }],
    attachments: [{ sourceId: S1, body: Buffer.from([0, 1, 2, 255, 10, 13]) }],
  };
  const buf = buildFullZip(data);
  const entries = parseZip(buf);
  assert.ok(entries.some((e) => e.name === "svod-full.json"));
  assert.ok(entries.some((e) => e.name === `attachments/${S1}`));
  const cls = classifyEntries(entries);
  assert.equal(cls.kind, "full");
  const full = cls.full!;
  assert.equal(full.folders.length, 2);
  assert.equal(full.notes.length, 2);
  const active = full.notes.find((n) => n.id === N1)!;
  assert.equal(active.body, body, "exact bytes incl BOM/CR/CRLF/space");
  assert.deepEqual(Buffer.from(active.body, "utf8").includes(Buffer.from([0xef, 0xbb, 0xbf])), true);
  const pending = full.notes.find((n) => n.id === P1)!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.target_note_id, N1);
  assert.equal(pending.token_label, "tok-label");
  assert.deepEqual(cls.attachments.get(S1), Buffer.from([0, 1, 2, 255, 10, 13]));
  // Other files are forbidden in the writer.
  for (const e of entries) {
    assert.ok(e.name === "svod-full.json" || e.name.startsWith("attachments/"));
  }
});

test("store and deflate both read; ../ and absolute rejected before write", () => {
  const storeBuf = zip([{ name: "a.md", body: Buffer.from("hello", "utf8") }]);
  assert.equal(parseZip(storeBuf)[0].body.toString("utf8"), "hello");
  const defBuf = makeDeflateZip([{ name: "b.md", body: Buffer.from("deflated body", "utf8") }]);
  assert.equal(parseZip(defBuf)[0].body.toString("utf8"), "deflated body");
  // Data descriptor + UTF-8 path (Compress-Archive style): writer sets bit 3,
  // reader must use central sizes. Our deflate helper omits the descriptor
  // flag; parse still succeeds via central dir (checked above).
  const badRel = zip([{ name: "../evil.md", body: Buffer.from("x", "utf8") }]);
  assert.throws(() => parseZip(badRel), SvodArchiveError);
  const badAbs = zip([{ name: "/abs.md", body: Buffer.from("x", "utf8") }]);
  assert.throws(() => parseZip(badAbs), SvodArchiveError);
  const badBack = zip([{ name: "a\\b.md", body: Buffer.from("x", "utf8") }]);
  assert.throws(() => parseZip(badBack), SvodArchiveError);
  // No DB writes happen on a rejected archive: pure plans never touch the pool.
  stubDb(() => {
    throw new Error("DB must not be touched by pure plan");
  });
  assert.throws(() => classifyEntries(parseZip(badRel)), SvodArchiveError);
});

// ─── repeated import / no-op ────────────────────────────────────────────────

test("repeat plan has no adds; skip path writes nothing (source-guarded)", () => {
  const archive = {
    format: "svod-full",
    version: 1,
    brain: { id: BRAIN, title: "B", slug: "b", goal: null, project_id: null, auto_index: false },
    folders: [{ id: F1, parent_id: null, name: "Guides" }],
    notes: [{
      id: N1, folder_id: F1, title: "Note", body: "body", status: "active",
      category: null, kind: "fact", author: "human", revision: 1,
      target_note_id: null, target_revision: null, proposed_by: null, token_id: null, token_label: null,
    }],
    sources: [],
    chunks: [],
  };
  const first = planFullImport({
    archive, targetBrainId: BRAIN,
    targetFolders: [], targetNotesById: new Map(),
    globalNoteBrain: new Map(), globalFolderIds: new Set(),
  });
  assert.equal(first.adds.length, 1);
  assert.equal(first.matches.length, 0);
  const second = planFullImport({
    archive, targetBrainId: BRAIN,
    targetFolders: [{ id: F1, parent_id: null, name: "Guides" }],
    targetNotesById: new Map([[N1, { folder_id: F1, title: "Note", body: "body", status: "active" }]]),
    globalNoteBrain: new Map(), globalFolderIds: new Set([F1]),
  });
  assert.equal(second.adds.length, 0, "repeat creates no adds");
  assert.equal(second.matches.length, 1);
  // Commit honours the decision: skip leaves matches untouched.
  const src = readFileSync(join(__dirname, "svod-import.ts"), "utf8");
  assert.match(src, /if \(decision === "update"\)/);
  assert.match(src, /tx\(async/);
});

test("update of identical bytes keeps chunk ids (sync no-op)", async () => {
  const { syncSvodSections } = await import("./svod-index");
  const mem = {
    chunks: [] as { id: string; input_hash: string | null; section_ordinal: number | null; content: string; embed_state: string; embed_fingerprint: string | null; embedding: string | null }[],
    outbox: [] as { chunk_id: string; input_hash: string }[],
  };
  let seq = 1;
  const client = {
    async query(text: string, params: unknown[] = []) {
      if (/select auto_index from brains/.test(text)) return { rows: [{ auto_index: false }] };
      if (/from chunks\s+where note_id/.test(text)) return { rows: mem.chunks.map((c) => ({ ...c })) };
      if (/delete from chunks where id/.test(text)) {
        mem.chunks = mem.chunks.filter((c) => c.id !== (params[0] as string));
        return { rows: [] };
      }
      if (/update chunks set section_ordinal/.test(text)) {
        const [id, ord, content] = params as [string, number, string];
        const c = mem.chunks.find((x) => x.id === id);
        if (c) {
          c.section_ordinal = ord;
          c.content = content;
        }
        return { rows: [] };
      }
      if (/insert into chunks/.test(text)) {
        const [, , content, , hash, ord] = params as [string, string, string, number, string, number];
        const id = `c-${seq++}`;
        mem.chunks.push({ id, input_hash: hash, section_ordinal: ord, content, embed_state: "pending", embed_fingerprint: null, embedding: null });
        return { rows: [{ id }] };
      }
      if (/insert into svod_embed_outbox/.test(text)) return { rows: [] };
      throw new Error(`unexpected: ${text.slice(0, 80)}`);
    },
  } as never;
  await syncSvodSections(client, { brainId: BRAIN, noteId: N1, title: "T", body: "# A\nx\n" });
  const ids1 = mem.chunks.map((c) => c.id);
  await syncSvodSections(client, { brainId: BRAIN, noteId: N1, title: "T", body: "# A\nx\n" });
  assert.deepEqual(mem.chunks.map((c) => c.id), ids1, "same bytes keep chunk ids");
});

// ─── foreign id ─────────────────────────────────────────────────────────────

test("foreign note id is a conflict, never taken", () => {
  const archive = {
    format: "svod-full",
    version: 1,
    brain: { id: BRAIN, title: "B", slug: "b", goal: null, project_id: null, auto_index: false },
    folders: [],
    notes: [{
      id: N1, folder_id: null, title: "Mine?", body: "x", status: "active",
      category: null, kind: "fact", author: "human", revision: 1,
      target_note_id: null, target_revision: null, proposed_by: null, token_id: null, token_label: null,
    }],
    sources: [],
    chunks: [],
  };
  const plan = planFullImport({
    archive, targetBrainId: BRAIN,
    targetFolders: [], targetNotesById: new Map(),
    globalNoteBrain: new Map([[N1, OTHER_BRAIN]]),
    globalFolderIds: new Set(),
  });
  assert.equal(plan.adds.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].id, N1);
  const src = readFileSync(join(__dirname, "svod-transfer.ts"), "utf8");
  assert.match(src, /belongs to another base/);
});

// ─── vectors ────────────────────────────────────────────────────────────────

test("vector stays ready on match + unconfirmed, pending on foreign fp", async () => {
  const { restoreVectorsForNote } = await import("./svod-import");
  process.env.EMBED_DIM ??= "1024";
  const mkMem = () => {
    const chunks = [{ id: "cur-1", input_hash: "h1" }];
    const updates: string[] = [];
    const deletes: string[] = [];
    const client = {
      async query(text: string, params: unknown[] = []) {
        if (/select id, input_hash from chunks where note_id/.test(text)) {
          return { rows: chunks.map((c) => ({ ...c })) };
        }
        if (/update chunks set embedding/.test(text)) {
          updates.push(String(params[0]));
          return { rows: [] };
        }
        if (/delete from svod_embed_outbox where chunk_id/.test(text)) {
          deletes.push(String(params[0]));
          return { rows: [] };
        }
        throw new Error(`unexpected vector query: ${text.slice(0, 80)}`);
      },
    } as never;
    return { client, updates, deletes };
  };
  const arch = [{ input_hash: "h1", embed_fingerprint: "fp-a", embedding: Array(1024).fill(0.01) }];
  // Confirmed + same fingerprint: write ready.
  {
    const m = mkMem();
    await restoreVectorsForNote(m.client, BRAIN, N1, arch, true, "fp-a");
    assert.equal(m.updates.length, 1);
    assert.equal(m.deletes.length, 1);
  }
  // Unconfirmed service: still write the archive vector + fingerprint.
  {
    const m = mkMem();
    await restoreVectorsForNote(m.client, BRAIN, N1, arch, false, null);
    assert.equal(m.updates.length, 1);
  }
  // Confirmed but different: leave pending, no write.
  {
    const m = mkMem();
    await restoreVectorsForNote(m.client, BRAIN, N1, arch, true, "fp-other");
    assert.equal(m.updates.length, 0);
    assert.equal(m.deletes.length, 0);
  }
  // Bad dimension never writes.
  {
    const m = mkMem();
    await restoreVectorsForNote(m.client, BRAIN, N1, [{ input_hash: "h1", embed_fingerprint: "fp-a", embedding: [1, 2] }], false, null);
    assert.equal(m.updates.length, 0);
  }
});

// ─── preview / markdown / permissions ───────────────────────────────────────

test("preview is pure: no pool writes", () => {
  let calls = 0;
  stubDb(() => {
    calls += 1;
    throw new Error("preview must not touch the pool");
  });
  const archive = {
    format: "svod-full",
    version: 1,
    brain: { id: BRAIN, title: "B", slug: "b", goal: null, project_id: null, auto_index: false },
    folders: [],
    notes: [],
    sources: [],
    chunks: [],
  };
  const p1 = planFullImport({
    archive, targetBrainId: BRAIN, targetFolders: [],
    targetNotesById: new Map(), globalNoteBrain: new Map(), globalFolderIds: new Set(),
  });
  const p2 = planMarkdownImport({ files: [], targetFolders: [], targetNotes: [] });
  assert.deepEqual(p1.adds, []);
  assert.deepEqual(p2.adds, []);
  assert.equal(calls, 0);
  const routeSrc = readFileSync(join(__dirname, "..", "app", "api", "brains", "[id]", "svod-import", "route.ts"), "utf8");
  assert.match(routeSrc, /phase === "preview"/);
  assert.ok(!/commitFullImport\(.*preview/.test(routeSrc));
});

test("markdown ZIP keeps the exact body and folder tree", () => {
  const folders = [
    { id: F1, parent_id: null, name: "Guides" },
    { id: F2, parent_id: F1, name: "UI" },
  ];
  const body = "﻿# T\rline\r\ntail \n";
  const buf = buildMarkdownZip(
    [{ id: N1, folder_id: F2, title: "Button", body }],
    folders,
  );
  const entries = parseZip(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "Guides/UI/Button.md");
  assert.equal(entries[0].body.toString("utf8"), body);
  assert.ok(!entries.some((e) => e.name === "svod-full.json"));
  // Sanitised names + collision suffix.
  assert.equal(sanitizeSegment("a:b/c*d"), "a_b_c_d");
  assert.equal(exportFileStem("a/b"), "a_b");
  const dup = markdownEntriesForNotes(
    [
      { id: N1, folder_id: null, title: "Same", body: "1" },
      { id: P1, folder_id: null, title: "Same", body: "2" },
    ],
    [],
  );
  assert.equal(dup.length, 2);
  assert.notEqual(dup[0].name, dup[1].name);
});

test("reader sees export but never imports; import needs edit + origin", () => {
  const importSrc = readFileSync(join(__dirname, "..", "app", "api", "brains", "[id]", "svod-import", "route.ts"), "utf8");
  assert.match(importSrc, /canEdit/);
  assert.match(importSrc, /status: 403/);
  assert.match(importSrc, /status: 404/);
  assert.match(importSrc, /isWorkspaceSameOriginRequest/);
  assert.match(importSrc, /decision/);
  const exportSrc = readFileSync(join(__dirname, "..", "app", "api", "brains", "[id]", "svod-export", "route.ts"), "utf8");
  assert.match(exportSrc, /canRead/);
  assert.match(exportSrc, /format.*full.*markdown|format.*markdown/s);
  const pageSrc = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "page.tsx"), "utf8");
  assert.match(pageSrc, /Export full archive/);
  assert.match(pageSrc, /Export Markdown/);
  assert.match(pageSrc, /SvodImportForm/);
  const formSrc = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "svod-transfer.tsx"), "utf8");
  assert.match(formSrc, /Update matches/);
  assert.match(formSrc, /Skip matches/);
});

test("full version mismatch and bad entries fail closed", () => {
  const badVersion = zip([{ name: "svod-full.json", body: Buffer.from(JSON.stringify({ format: "svod-full", version: 2 }), "utf8") }]);
  assert.throws(() => classifyEntries(parseZip(badVersion)), /version/);
  const badFormat = zip([{ name: "notes.txt", body: Buffer.from("x", "utf8") }]);
  assert.throws(() => classifyEntries(parseZip(badFormat)), /importable/);
  // Zip bomb ratio: 1 compressed byte claiming 32 MiB is rejected wholly.
  const bombCentral = (): Buffer => {
    const name = Buffer.from("big.md", "utf8");
    const comp = Buffer.from([0x00]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(Buffer.alloc(10)), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(32 * 1024 * 1024, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(Buffer.alloc(10)), 16);
    dir.writeUInt32LE(comp.length, 20);
    dir.writeUInt32LE(32 * 1024 * 1024, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(30 + name.length, 42);
    const centralBytes = Buffer.concat([dir, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(30 + name.length + comp.length, 16);
    return Buffer.concat([local, name, comp, centralBytes, end]);
  };
  assert.throws(() => parseZip(bombCentral()), /zip bomb|too large/i);
});

// ─── revision fixes: collision titles, pending no-op, brains touch, rollback ─

test("markdown repeat with collision keeps both titles, no resync, no brains touch", async () => {
  const { commitMarkdownImport } = await import("./svod-import");
  const seedNotes = [
    { id: N1, brain_id: BRAIN, folder_id: null as string | null, title: "Same", body: "one", status: "active" },
    { id: P1, brain_id: BRAIN, folder_id: null as string | null, title: "Same", body: "two", status: "active" },
  ];
  const buf = buildMarkdownZip(
    seedNotes.map((n) => ({ id: n.id, folder_id: n.folder_id, title: n.title, body: n.body })),
    [],
  );
  const files = parseZip(buf).map((e) => ({ name: e.name, body: e.body.toString("utf8") }));
  assert.equal(files.length, 2);
  const plan = planMarkdownImport({ files, targetFolders: [], targetNotes: seedNotes });
  assert.equal(plan.matches.length, 2);
  for (const op of plan.ops) {
    assert.equal(op.title, "Same", "suffix never becomes the title");
  }
  const seen: string[] = [];
  let brainsUpdates = 0;
  const liveNotes = seedNotes.map((n) => ({ ...n }));
  stubDb((text) => {
    seen.push(text);
    if (/select id from brains where id/.test(text)) return [{ id: BRAIN }];
    if (/from folders where brain_id = \$1/.test(text)) return [];
    if (/from notes where brain_id = \$1 and status = 'active'/.test(text)) return liveNotes;
    if (/update brains set content_changed_at/.test(text)) {
      brainsUpdates += 1;
      return [];
    }
    throw new Error(`unexpected query: ${text.slice(0, 100)}`);
  });
  const r = await commitMarkdownImport({ brainId: BRAIN, files, decision: "update" });
  assert.deepEqual(r, { added: 0, updated: 0, skipped: 2, conflicts: 0, errors: [] });
  assert.deepEqual(liveNotes.map((n) => n.title), ["Same", "Same"]);
  assert.deepEqual(liveNotes.map((n) => n.body), ["one", "two"]);
  assert.equal(brainsUpdates, 0, "same bytes never mark the base changed");
  assert.ok(!seen.some((s) => /chunks|outbox|auto_index/.test(s)), "syncSvodSections not called when body unchanged");
});

test("unchanged pending proposal performs no UPDATE and keeps its revision", async () => {
  const { commitFullImport } = await import("./svod-import");
  const ACTIVE = N1;
  const PENDING = P1;
  const live = [
    { id: ACTIVE, folder_id: null as string | null, title: "Base", body: "base body", status: "active", category: null, kind: "fact", revision: 5, target_note_id: null as string | null, target_revision: null as number | null },
    { id: PENDING, folder_id: null as string | null, title: "Fix", body: "fixed body", status: "pending", category: null, kind: "fact", revision: 3, target_note_id: ACTIVE, target_revision: 5 },
  ];
  const archive = {
    format: "svod-full",
    version: 1,
    brain: { id: BRAIN, title: "B", slug: "b", goal: null, project_id: null, auto_index: false },
    folders: [],
    notes: live.map((n) => ({
      id: n.id, folder_id: n.folder_id, title: n.title, body: n.body, status: n.status,
      category: n.category, kind: n.kind, author: "human", revision: n.revision,
      target_note_id: n.target_note_id, target_revision: n.target_revision,
      proposed_by: null, token_id: null, token_label: null,
    })),
    sources: [],
    chunks: [],
  };
  const seen: string[] = [];
  let brainsUpdates = 0;
  stubDb((text, params) => {
    seen.push(text);
    if (/select id from brains where id/.test(text)) return [{ id: BRAIN }];
    if (/from folders where brain_id = \$1/.test(text) && !/coalesce/.test(text)) return [];
    if (/from notes where brain_id = \$1/.test(text) && !/where id =/.test(text)) return live;
    if (/select brain_id from notes where id = \$1/.test(text)) {
      const row = live.find((n) => n.id === (params as string[])[0]);
      return row ? [{ brain_id: BRAIN }] : [];
    }
    if (/select revision from notes where id = \$1/.test(text)) {
      const row = live.find((n) => n.id === (params as string[])[0] && n.status === "active");
      return row ? [{ revision: row.revision }] : [];
    }
    if (/update brains set content_changed_at/.test(text)) {
      brainsUpdates += 1;
      return [];
    }
    throw new Error(`unexpected query: ${text.slice(0, 120)}`);
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith("/fingerprint")) return Response.json({ id: "fp-x", confirmed: false });
    throw new Error("no embed calls expected");
  }) as typeof fetch;
  try {
    const r = await commitFullImport({ brainId: BRAIN, archive, attachments: new Map(), decision: "update" });
    assert.deepEqual(r, { added: 0, updated: 0, skipped: 2, conflicts: 0, errors: [] });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(!seen.some((s) => /^update notes set/.test(s.trim())), "identical proposal issues no UPDATE, revision untouched");
  assert.equal(brainsUpdates, 0, "no-op import never marks the base changed");
});

test("unexpected write failure rolls the whole import back", async () => {
  const { commitMarkdownImport } = await import("./svod-import");
  stubDb((text) => {
    if (/select id from brains where id/.test(text)) return [{ id: BRAIN }];
    if (/from folders where brain_id = \$1/.test(text)) return [];
    if (/from notes where brain_id = \$1 and status = 'active'/.test(text)) return [];
    if (/insert into notes/.test(text)) throw new Error("boom-write");
    if (/update brains set content_changed_at/.test(text)) return [];
    throw new Error(`unexpected query: ${text.slice(0, 100)}`);
  });
  await assert.rejects(
    () => commitMarkdownImport({ brainId: BRAIN, files: [{ name: "a.md", body: "hello" }], decision: "skip" }),
    /boom-write/,
  );
  const src = readFileSync(join(__dirname, "svod-import.ts"), "utf8");
  assert.ok(!src.includes("not saved:"), "note INSERT failures must throw, not land in errors");
  assert.ok(!src.includes("not updated:"), "note UPDATE failures must throw, not land in errors");
});

test("import UI stays on errors and reloads only a clean commit", () => {
  const formSrc = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "svod-transfer.tsx"), "utf8");
  assert.match(formSrc, /data\.errors && data\.errors\.length/);
  assert.match(formSrc, /window\.location\.reload\(\)/);
});

// ─── live Postgres (skipped without SVOD_TEST_DATABASE_URL) ────────────────

const LIVE_URL = process.env.SVOD_TEST_DATABASE_URL ?? "";

test("live: markdown commit repeats without dupes (real Postgres)", async () => {
  if (!LIVE_URL) {
    console.log("skip live: no SVOD_TEST_DATABASE_URL");
    return;
  }
  const { Client } = await import("pg");
  const c = new Client({ connectionString: LIVE_URL });
  await c.connect();
  const { pool } = await import("@/db");
  const prevQuery = pool.query;
  const prevConnect = pool.connect;
  pool.query = ((text: string, params?: unknown[]) => c.query(text, params as never[])) as never;
  pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => c.query(text, params as never[]),
    release: () => {},
  })) as never;
  try {
    const tag = `live6-${Date.now()}`;
    await c.query(`insert into "user" (id, email, name, plan) values ($1, $2, 'Live', 'free') on conflict (id) do nothing`, [`u-${tag}`, `${tag}@test.local`]);
    const b = await c.query(`insert into brains (owner_id, slug, title) values ($1, $2, $3) returning id`, [`u-${tag}`, `slug-${tag}`.slice(0, 40), `B-${tag}`]);
    const brainId = b.rows[0].id as string;
    const { commitMarkdownImport } = await import("./svod-import");
    const files = [{ name: "Guides/note.md", body: "live body" }];
    const r1 = await commitMarkdownImport({ brainId, files, decision: "skip" });
    assert.equal(r1.added, 1);
    const r2 = await commitMarkdownImport({ brainId, files, decision: "skip" });
    assert.equal(r2.added, 0);
    assert.equal(r2.updated, 0);
    await c.query(`delete from brains where id = $1`, [brainId]).catch(() => {});
    await c.query(`delete from "user" where id = $1`, [`u-${tag}`]).catch(() => {});
  } finally {
    pool.query = prevQuery;
    pool.connect = prevConnect;
    await c.end().catch(() => {});
  }
});
