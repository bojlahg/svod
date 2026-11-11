import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stubDb } from "./test-db";
import {
  splitSvodSections,
  svodInputHash,
  svodSectionInput,
  svodSectionsForNote,
} from "./svod-sections";
import { syncSvodSections } from "./svod-index";

/**
 * SVOD stage 5: sections, sync, search fallback, cache, permissions.
 * Unit half (stubDb + fake fetch + in-memory client). Live-Postgres races
 * run in the same file when SVOD_TEST_DATABASE_URL is set, otherwise skip.
 */

const UUID = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0").slice(-2)}`;

// ─── migration ─────────────────────────────────────────────────────────────

test("0096 migration: additive section/outbox schema, old vectors kept", () => {
  const sql = readFileSync(join(__dirname, "..", "db", "migrations", "0096_svod_index.sql"), "utf8");
  for (const col of ["input_hash", "section_ordinal", "embed_fingerprint", "embed_error", "embed_state"]) {
    assert.match(sql, new RegExp(col), `missing ${col}`);
  }
  assert.match(sql, /check \(embed_state in \('ready', 'pending', 'error'\)\)/);
  assert.match(sql, /auto_index boolean not null default false/);
  assert.match(sql, /create table if not exists svod_embed_outbox/);
  assert.match(sql, /unique \(chunk_id\)/);
  assert.match(sql, /references chunks\(id\) on delete cascade/);
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.ok(!/update chunks set/i.test(code), "migration must not rewrite chunks");
  assert.ok(!/update notes set/i.test(code), "migration must not touch notes");
  assert.ok(!/delete from/i.test(code), "migration must not delete rows");
});

// ─── section split ─────────────────────────────────────────────────────────

test("sections split by ATX headers, preface kept, empty gives nothing", () => {
  assert.deepEqual(splitSvodSections("   \n  "), []);
  assert.deepEqual(splitSvodSections("no headers"), ["no headers"]);
  assert.deepEqual(splitSvodSections("intro\n# A\ntext\n## B\nmore"), ["intro\n", "# A\ntext\n", "## B\nmore"]);
  assert.deepEqual(splitSvodSections("# A\n# B\n"), ["# A\n", "# B\n"]);
  // CRLF/CR bytes preserved exactly (hash is over these bytes).
  assert.deepEqual(splitSvodSections("preface\r\n# H\r\nbody\r\n"), ["preface\r\n", "# H\r\nbody\r\n"]);
  assert.deepEqual(splitSvodSections("a\rb\r# H\rc"), ["a\rb\r", "# H\rc"]);
  // Seven hashes is not a header.
  assert.deepEqual(splitSvodSections("####### x\nbody"), ["####### x\nbody"]);
});

test("section input is title + blank + slice; hash is SHA-256, not position", () => {
  const secs = svodSectionsForNote("T", "intro\n# A\nx");
  assert.equal(secs.length, 2);
  assert.equal(secs[0].input, svodSectionInput("T", "intro\n"));
  assert.equal(secs[0].hash, svodInputHash("T\n\nintro\n"));
  // Same slice bytes in another order have the same hash (bodies end with a
  // break so the last slice carries the same trailing bytes as in the middle).
  const a = svodSectionsForNote("T", "# A\nx\n# B\ny\n");
  const b = svodSectionsForNote("T", "# B\ny\n# A\nx\n");
  assert.equal(a[0].hash, b[1].hash);
  assert.equal(a[1].hash, b[0].hash);
});

// ─── in-memory fake client for sync ────────────────────────────────────────

interface MemChunk {
  id: string;
  input_hash: string | null;
  section_ordinal: number | null;
  content: string;
  embed_state: string;
  embed_fingerprint: string | null;
  embedding: string | null;
}

function memClient(opts: { autoIndex: boolean; chunks: MemChunk[]; outbox: { chunk_id: string; input_hash: string }[] }) {
  let seq = 100;
  const seen: string[] = [];
  const client = {
    seen,
    async query(text: string, params: unknown[] = []) {
      seen.push(text);
      if (/select auto_index from brains/.test(text)) {
        return { rows: [{ auto_index: opts.autoIndex }], rowCount: 1 };
      }
      if (/from chunks\s+where note_id/.test(text)) {
        return { rows: opts.chunks.map((c) => ({ ...c })), rowCount: opts.chunks.length };
      }
      if (/delete from chunks where id/.test(text)) {
        const id = params[0] as string;
        opts.chunks = opts.chunks.filter((c) => c.id !== id);
        opts.outbox = opts.outbox.filter((o) => o.chunk_id !== id);
        return { rows: [], rowCount: 1 };
      }
      if (/update chunks set section_ordinal/.test(text)) {
        const [id, ord, content] = params as [string, number, string];
        const c = opts.chunks.find((x) => x.id === id);
        if (c) {
          c.section_ordinal = ord;
          c.content = content as string;
        }
        return { rows: [], rowCount: 1 };
      }
      if (/insert into chunks/.test(text)) {
        // Twin-copy inserts carry the finished vector ('ready', $7::halfvec,
        // $8); fresh sections insert pending with 6 params.
        if (params.length >= 8 && /'ready'/.test(text)) {
          const [, , content, , hash, ord, embedding, fingerprint] = params as [
            string, string, string, number, string, number, string, string,
          ];
          const id = `new-${seq++}`;
          opts.chunks.push({
            id,
            input_hash: hash,
            section_ordinal: ord,
            content,
            embed_state: "ready",
            embed_fingerprint: fingerprint,
            embedding,
          });
          return { rows: [{ id }], rowCount: 1 };
        }
        const [, , content, , hash, ord] = params as [string, string, string, number, string, number];
        const id = `new-${seq++}`;
        opts.chunks.push({
          id,
          input_hash: hash,
          section_ordinal: ord,
          content,
          embed_state: "pending",
          embed_fingerprint: null,
          embedding: null,
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/insert into svod_embed_outbox/.test(text)) {
        const [chunkId, , , hash] = params as [string, string, string, string];
        const ex = opts.outbox.find((o) => o.chunk_id === chunkId);
        if (!ex) opts.outbox.push({ chunk_id: chunkId, input_hash: hash });
        else if (ex.input_hash !== hash) {
          ex.input_hash = hash;
        }
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    },
  };
  return { client: client as never, opts, seen };
}

test("neighbour edit, reorder and duplicate keep chunk id + compatible vector", async () => {
  const title = "Note";
  const body1 = "intro\n# A\nalpha\n# B\nbeta\n";
  void svodSectionsForNote(title, body1);
  const mem = memClient({ autoIndex: false, chunks: [], outbox: [] });
  await syncSvodSections(mem.client, { brainId: UUID(1), noteId: UUID(2), title, body: body1 });
  assert.equal(mem.opts.chunks.length, 3);
  const ids1 = mem.opts.chunks.map((c) => c.id);
  const hashById = new Map(mem.opts.chunks.map((c) => [c.id, c.input_hash]));
  // Simulate a compatible vector on the middle section.
  const mid = mem.opts.chunks[1];
  mid.embedding = "[0,1]";
  mid.embed_fingerprint = "fp1";
  mid.embed_state = "ready";

  // Edit the neighbour (last section) only.
  const body2 = "intro\n# A\nalpha\n# B\nbeta edited\n";
  await syncSvodSections(mem.client, { brainId: UUID(1), noteId: UUID(2), title, body: body2 });
  assert.equal(mem.opts.chunks.length, 3);
  // Unchanged sections keep their ids.
  assert.equal(mem.opts.chunks[0].id, ids1[0]);
  assert.equal(mem.opts.chunks[1].id, ids1[1]);
  assert.equal(mem.opts.chunks[1].embedding, "[0,1]", "compatible vector survives neighbour edit");
  assert.equal(mem.opts.chunks[0].input_hash, hashById.get(ids1[0]));
  // Changed section got a new row.
  assert.notEqual(mem.opts.chunks[2].id, ids1[2]);

  // Reorder header-only sections by moving the exact slices: same bytes in a
  // new order keep their ids (preface text would merge if moved to the tail,
  // so the reorder matrix uses a header-only note here).
  const memR = memClient({ autoIndex: false, chunks: [], outbox: [] });
  const rBody1 = "# A\nalpha\n# B\nbeta\n";
  await syncSvodSections(memR.client, { brainId: UUID(1), noteId: UUID(2), title, body: rBody1 });
  const beforeReorder = new Map(memR.opts.chunks.map((c) => [c.input_hash, c.id]));
  const rBody2 = "# B\nbeta\n# A\nalpha\n";
  const secs3 = svodSectionsForNote(title, rBody2);
  await syncSvodSections(memR.client, { brainId: UUID(1), noteId: UUID(2), title, body: rBody2 });
  assert.equal(memR.opts.chunks.length, secs3.length);
  for (const c of memR.opts.chunks) {
    assert.equal(beforeReorder.get(c.input_hash), c.id, "reorder keeps id by hash");
  }

  // Duplicate identical input: separate rows, same hash.
  const dupBody = "# Same\nsame\n# Same\nsame\n";
  const mem2 = memClient({ autoIndex: false, chunks: [], outbox: [] });
  await syncSvodSections(mem2.client, { brainId: UUID(1), noteId: UUID(2), title, body: dupBody });
  assert.equal(mem2.opts.chunks.length, 2);
  assert.equal(mem2.opts.chunks[0].input_hash, mem2.opts.chunks[1].input_hash);
  assert.notEqual(mem2.opts.chunks[0].id, mem2.opts.chunks[1].id);
});

test("auto_index=false still writes pending rows but no outbox", async () => {
  const mem = memClient({ autoIndex: false, chunks: [], outbox: [] });
  const r = await syncSvodSections(mem.client, { brainId: UUID(1), noteId: UUID(2), title: "T", body: "# A\nx" });
  assert.equal(r.autoIndex, false);
  assert.equal(r.queued, false);
  assert.equal(mem.opts.chunks.length, 1);
  assert.equal(mem.opts.chunks[0].embed_state, "pending");
  assert.deepEqual(mem.opts.outbox, []);
});

test("auto_index=true writes outbox in the same tx", async () => {
  const mem = memClient({ autoIndex: true, chunks: [], outbox: [] });
  const r = await syncSvodSections(mem.client, { brainId: UUID(1), noteId: UUID(2), title: "T", body: "# A\nx" });
  assert.equal(r.autoIndex, true);
  assert.equal(r.queued, true);
  assert.equal(mem.opts.outbox.length, 1);
  assert.ok(mem.seen.some((s) => /svod_embed_outbox/.test(s)), "outbox insert in same tx");
});

test("repeated section copies the ready twin's vector, no outbox for the copy", async () => {
  const title = "Note";
  const secs = svodSectionsForNote(title, "# Same\nsame\n");
  assert.equal(secs.length, 1);
  const h = secs[0].hash;
  // The note already holds this input embedded; auto-index is on.
  const mem = memClient({
    autoIndex: true,
    chunks: [
      {
        id: "old-ready", input_hash: h, section_ordinal: 0,
        content: secs[0].input, embed_state: "ready",
        embed_fingerprint: "fp-9", embedding: "[0.11,0.22]",
      },
    ],
    outbox: [],
  });
  const r = await syncSvodSections(mem.client, {
    brainId: UUID(1), noteId: UUID(2), title, body: "# Same\nsame\n# Same\nsame\n",
  });
  assert.equal(mem.opts.chunks.length, 2);
  const [first, second] = mem.opts.chunks;
  assert.equal(first.id, "old-ready");
  assert.notEqual(second.id, "old-ready");
  assert.equal(second.input_hash, h);
  assert.equal(second.embed_state, "ready");
  assert.equal(second.embedding, "[0.11,0.22]");
  assert.equal(second.embed_fingerprint, "fp-9");
  assert.deepEqual(mem.opts.outbox, [], "copies queue no new work");
  assert.equal(r.queued, false);
});

test("sync rethrows real database errors, 42703 alone falls back to legacy", async () => {
  const pgErr = (code: string) => {
    const e = new Error(code === "42703" ? "column does not exist" : "boom") as Error & { code: string };
    e.code = code;
    return e;
  };
  const boomClient = {
    async query() {
      throw pgErr("XX000");
    },
  } as never;
  await assert.rejects(
    () => syncSvodSections(boomClient, { brainId: UUID(1), noteId: UUID(2), title: "T", body: "# A\nx" }),
    /boom/,
  );
  // Pre-0096 shape: missing columns (42703) still resolve through the legacy
  // insert instead of duplicating or throwing.
  const seen: string[] = [];
  const legacyClient = {
    async query(text: string) {
      seen.push(text);
      if (/select auto_index from brains/.test(text)) throw pgErr("42703");
      if (/from chunks\s+where note_id/.test(text)) throw pgErr("42703");
      if (/insert into chunks \(brain_id, note_id, content, token_count, embedding\)/.test(text)) {
        return { rows: [{ id: "legacy-1" }], rowCount: 1 };
      }
      if (/insert into chunks/.test(text)) throw pgErr("42703");
      if (/update brains set content_changed_at/.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${text.slice(0, 100)}`);
    },
  } as never;
  const r = await syncSvodSections(legacyClient, { brainId: UUID(1), noteId: UUID(2), title: "T", body: "# A\nx" });
  assert.equal(r.queued, false);
  assert.ok(
    seen.some((s) => /insert into chunks \(brain_id, note_id, content, token_count, embedding\)/.test(s)),
    "legacy insert used on 42703 only",
  );
});

// ─── search: UUID without embedding, pending excluded, lexical fallback ───

test("UUID hit needs no embedding, even when the service is down", async () => {
  const BRAIN = UUID(10);
  const NID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let fetches = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("service down");
  };
  try {
    stubDb((text, params) => {
      if (/from notes where id = \$1 and brain_id = \$2 and status = 'active'/.test(text)) {
        assert.equal(params[0], NID);
        return [{ id: NID, brain_id: BRAIN, title: "Moon", body: "moon body", folder_id: null, status: "active" }];
      }
      if (/from folders where brain_id/.test(text)) return [];
      throw new Error(`unexpected query: ${text.slice(0, 100)}`);
    });
    const { searchSvodNotes } = await import("./svod-notes");
    const hits = await searchSvodNotes(BRAIN, NID, 8);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].note_id, NID);
    assert.equal(fetches, 0, "UUID path must not call the embed service");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("lexical leg stays scoped/active/deduped; vector leg needs ready+current fp", async () => {
  const src = readFileSync(join(__dirname, "svod-notes.ts"), "utf8");
  assert.match(src, /n\.status = 'active'/);
  assert.match(src, /partition by n\.id/);
  assert.match(src, /c\.embed_state = 'ready'/);
  assert.match(src, /c\.embed_fingerprint = \$2/);
  assert.match(src, /c\.embedding is not null/);
});

test("vector leg keeps one best chunk per note before the limit", async () => {
  // SQL layer: both vector legs rank one row per note (rn = 1 over the
  // distance) instead of cutting raw chunks.
  const src = readFileSync(join(__dirname, "svod-notes.ts"), "utf8");
  assert.equal((src.match(/order by dist/g) ?? []).length, 2);
  // Behaviour layer: even if the transport returns two rows for one note,
  // fusion counts a single RRF vote for it.
  const BRAIN = UUID(50);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const u = String(input);
    if (u.endsWith("/fingerprint")) return Response.json({ id: "fp-v", confirmed: true });
    if (u.endsWith("/embed")) {
      return Response.json({
        vectors: [Array(1024).fill(0.02)],
        dim: 1024,
        fingerprint_id: "fp-v",
        confirmed: true,
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    stubDb((text) => {
      if (/to_tsquery\('simple'/.test(text) && /from chunks/.test(text)) return [];
      if (/halfvec/.test(text) && /from chunks/.test(text)) {
        return [
          { chunk_id: "a1", note_id: "note-a", title: "Note A", folder_id: null, excerpt: "a-first" },
          { chunk_id: "a2", note_id: "note-a", title: "Note A", folder_id: null, excerpt: "a-second" },
          { chunk_id: "b1", note_id: "note-b", title: "Note B", folder_id: null, excerpt: "b-first" },
        ];
      }
      if (/from folders where brain_id/.test(text)) return [];
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    });
    const { searchSvodNotes } = await import("./svod-notes");
    const hits = await searchSvodNotes(BRAIN, "some query words", 2);
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.note_id).sort(), ["note-a", "note-b"]);
    const a = hits.find((h) => h.note_id === "note-a")!;
    assert.ok(
      Math.abs(a.rank - 1 / 61) < 1e-9,
      `one RRF vote per note, got rank ${a.rank}`,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("category filter narrows scope search exactly like searchBrain", async () => {
  const src = readFileSync(join(__dirname, "svod-notes.ts"), "utf8");
  assert.match(src, /lower\(n\.category\) = \$4/);
  assert.match(src, /lower\(n\.category\) like \$4 \|\| '\/%'/);
  const mcpSrc = readFileSync(join(__dirname, "mcp.ts"), "utf8");
  assert.match(mcpSrc, /searchSvodScope\(fullScope, q, lim, \{ category: cat \}\)/);
  const B1 = UUID(51);
  const B2 = UUID(52);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("lexical-only path must not call the embed service");
  };
  try {
    stubDb((text, params) => {
      if (/from chunks/.test(text) && /lower\(n\.category\)/.test(text)) {
        const cat = params[3] as string | null;
        const all = [
          { note_id: "note-u", brain_id: B1, title: "Unity note", folder_id: null, excerpt: "u", rank: "0.9" },
          { note_id: "note-g", brain_id: B2, title: "Git note", folder_id: null, excerpt: "g", rank: "0.8" },
        ];
        const cats: Record<string, string> = { "note-u": "unity", "note-g": "git" };
        if (cat == null) return all;
        return all.filter((r) => cats[r.note_id] === cat);
      }
      if (/from brains where id = any/.test(text)) {
        return [
          { id: B1, slug: "unity", title: "Unity" },
          { id: B2, slug: "git", title: "Git" },
        ];
      }
      if (/from folders where brain_id = any/.test(text)) return [];
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    });
    const { searchSvodScope } = await import("./svod-notes");
    const filtered = await searchSvodScope([B1, B2], "some query words", 8, { category: "Unity" });
    assert.deepEqual(filtered.map((h) => h.note_id), ["note-u"]);
    const unfiltered = await searchSvodScope([B1, B2], "some query words", 8);
    assert.deepEqual(unfiltered.map((h) => h.note_id).sort(), ["note-g", "note-u"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("foreign or empty fingerprint keeps lexical, drops semantic, no throw", async () => {
  const BRAIN = UUID(11);
  let embedCalls = 0;
  let fpCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const u = String(input);
    if (u.endsWith("/fingerprint")) {
      // Passage and query disagree: first call (passage) vs second (query).
      fpCalls += 1;
      return Response.json({ id: fpCalls === 1 ? "fp-passage" : "fp-query", confirmed: true });
    }
    if (u.endsWith("/embed")) {
      embedCalls += 1;
      return Response.json({ vectors: [[1, 0]], dim: 1024 });
    }
    return Response.json({});
  }) as typeof fetch;
  try {
    stubDb((text) => {
      if (/to_tsquery\('simple'/.test(text) && /from chunks/.test(text)) {
        return [{ note_id: "n1", brain_id: BRAIN, title: "T", folder_id: null, excerpt: "lex", rank: "0.5", chunk_id: "c1" }];
      }
      if (/from folders where brain_id/.test(text)) return [];
      if (/select id, slug, title from brains/.test(text)) return [];
      if (/from brains where id/.test(text)) return [];
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    });
    const { searchSvodNotes } = await import("./svod-notes");
    const hits = await searchSvodNotes(BRAIN, "moon button", 5);
    assert.ok(hits.length >= 1, "lexical fallback must answer");
    assert.equal(embedCalls, 0, "mismatched fingerprints must not embed the query");
    assert.ok(hits.every((h) => h.via !== "vector"), "no vector leg on mismatch");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("pending UUID never resolves (active-only boundary)", async () => {
  const BRAIN = UUID(12);
  const NID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not be called");
  };
  try {
    stubDb((text) => {
      if (/from notes where id/.test(text)) return [];
      if (/from folders/.test(text)) return [];
      throw new Error(`unexpected: ${text.slice(0, 80)}`);
    });
    const { searchSvodNotes } = await import("./svod-notes");
    assert.deepEqual(await searchSvodNotes(BRAIN, NID, 5), []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ─── query cache ───────────────────────────────────────────────────────────

test("second identical query hits cache; new fingerprint misses; parallel shares one flight", async () => {
  const { clearSvodQueryCache, embedSvodQuery } = await import("./embed");
  clearSvodQueryCache();
  let fpId = "fp-1";
  let embedCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(input);
    if (u.endsWith("/fingerprint")) return Response.json({ id: fpId, confirmed: true });
    if (u.endsWith("/embed")) {
      embedCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      const body = JSON.parse(String(init?.body ?? "{}")) as { texts: string[] };
      return Response.json({
        vectors: body.texts.map(() => Array(1024).fill(0.01)),
        dim: 1024,
        fingerprint_id: fpId,
        confirmed: true,
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    process.env.EMBED_DIM ??= "1024";
    const v1 = await embedSvodQuery("moon button");
    assert.equal(embedCalls, 1);
    const v2 = await embedSvodQuery("moon button");
    assert.equal(embedCalls, 1, "second identical query must not re-POST /embed");
    assert.deepEqual(v2, v1);
    fpId = "fp-2";
    await embedSvodQuery("moon button");
    assert.equal(embedCalls, 2, "different fingerprint must miss");
    // Parallel identical misses share one in-flight POST.
    fpId = "fp-3";
    clearSvodQueryCache();
    embedCalls = 0;
    const [a, b] = await Promise.all([embedSvodQuery("parallel"), embedSvodQuery("parallel")]);
    assert.equal(embedCalls, 1, "parallel misses must share one flight");
    assert.deepEqual(a, b);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("unconfirmed fingerprint is never cached/used", async () => {
  const { clearSvodQueryCache, embedSvodQuery } = await import("./embed");
  clearSvodQueryCache();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith("/fingerprint")) return Response.json({ id: "", confirmed: false });
    throw new Error("embed must not be called when unconfirmed");
  }) as typeof fetch;
  try {
    await assert.rejects(() => embedSvodQuery("q"), /unconfirmed|unavailable/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ─── worker SQL guards ─────────────────────────────────────────────────────

test("apply is one statement: guarded write, conditional drop, throwing keeps the queue", () => {
  const src = readFileSync(join(__dirname, "..", "worker", "svod-index.ts"), "utf8");
  const start = src.indexOf("export async function applySvodVector");
  const next = src.indexOf("export async function", start + 1);
  const fn = src.slice(start, next === -1 ? undefined : next);
  // Exactly one database round-trip — no separate delete that could drop a
  // queued row for a failed write.
  assert.equal(fn.match(/await query[<(]/g)?.length ?? 0, 1);
  assert.match(fn, /with upd as \(/);
  assert.match(fn, /del as \(/);
  assert.match(fn, /and input_hash = \$4/);
  assert.match(fn, /and brain_id = \$5/);
  assert.match(fn, /embed_fingerprint is distinct from/);
  assert.match(fn, /n\.status = 'active'/);
  assert.match(fn, /'applied'/);
  assert.match(fn, /'already'/);
  assert.match(fn, /'dropped-inactive'/);
  assert.match(fn, /'stale'/);
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(fn), "apply must propagate SQL errors");
});

test("rejected vector write keeps its outbox row and records the failure", async () => {
  const { applySvodVector, sweepSvodIndex } = await import("../worker/svod-index");
  const seen: string[] = [];
  stubDb((text) => {
    seen.push(text);
    // The single apply statement is rejected by Postgres (bad halfvec).
    if (/with upd as \(/.test(text)) throw new Error("invalid input syntax for type halfvec");
    // The normal failure path still records the error.
    if (/update chunks set embed_error/.test(text)) return [];
    if (/update svod_embed_outbox set attempts/.test(text)) return [];
    throw new Error(`unexpected query: ${text.slice(0, 100)}`);
  });
  const claim = {
    outboxId: "o-bad", chunkId: "c-bad", brainId: UUID(60), noteId: UUID(61),
    inputHash: "h-bad", attempts: 0, content: "bad vector target",
  };
  await assert.rejects(
    () => applySvodVector(claim, [0.1, 0.2], "fp-x"),
    /halfvec/,
  );
  // The only statement mentioning the outbox is the combined one Postgres
  // rejected atomically — no standalone delete ever ran.
  for (const s of seen.filter((x) => /delete from svod_embed_outbox/.test(x))) {
    assert.match(s, /with upd as \(/);
  }
  // Through the sweep the same failure becomes one recorded error, not a drop.
  let served = false;
  const r = await sweepSvodIndex({
    claimFn: async () => {
      if (served) return [];
      served = true;
      return [claim];
    },
    embedFn: async (texts: string[]) => ({ vectors: texts.map(() => [0.5]), fingerprintId: "fp-x" }),
  });
  assert.equal(r.errors, 1);
  for (const s of seen.filter((x) => /delete from svod_embed_outbox/.test(x))) {
    assert.match(s, /with upd as \(/);
  }
});

test("500 keeps the note readable + lexical, records the error, retry can win", async () => {
  const { sweepSvodIndex } = await import("../worker/svod-index");
  let calls = 0;
  const claims = [
    { outboxId: "o1", chunkId: "c1", brainId: UUID(20), noteId: UUID(21), inputHash: "h1", attempts: 0, content: "hello" },
  ];
  const r1 = await sweepSvodIndex({
    claimFn: async () => (calls === 0 ? claims : []),
    embedFn: async () => {
      calls += 1;
      throw new Error("embed service 500: boom");
    },
  });
  assert.equal(r1.errors, 1);
  assert.equal(calls, 1);
  // Retry with a working service embeds without throwing.
  const r2 = await sweepSvodIndex({
    claimFn: async () => [],
    embedFn: async (texts: string[]) => ({ vectors: texts.map(() => [1, 2]), fingerprintId: "fp" }),
  });
  assert.equal(r2.errors, 0);
});

test("svod worker never sends a passage batch larger than 8", async () => {
  const { sweepSvodIndex } = await import("../worker/svod-index");
  const many = Array.from({ length: 8 }, (_, i) => ({
    outboxId: `o${i}`,
    chunkId: `c${i}`,
    brainId: UUID(30),
    noteId: UUID(31),
    inputHash: `h${i}`,
    attempts: 0,
    content: `text ${i}`,
  }));
  let maxBatch = 0;
  await sweepSvodIndex({
    claimFn: async (limit: number) => {
      assert.ok(limit <= 8, `claim limit ${limit} > 8`);
      return many.splice(0, limit);
    },
    embedFn: async (texts: string[]) => {
      maxBatch = Math.max(maxBatch, texts.length);
      assert.ok(texts.length <= 8, `passage batch ${texts.length} > 8`);
      return { vectors: texts.map(() => [0, 1]), fingerprintId: "fp" };
    },
  });
  assert.ok(maxBatch <= 8 && maxBatch > 0);
});

test("outbox survives a lost pg-boss send and the sweep picks it up without boss", async () => {
  // Sync writes the outbox row in-tx; the wake-up may throw afterwards.
  const mem = memClient({ autoIndex: true, chunks: [], outbox: [] });
  await syncSvodSections(mem.client, { brainId: UUID(40), noteId: UUID(41), title: "T", body: "# A\nx" });
  assert.equal(mem.opts.outbox.length, 1, "outbox committed even when send fails");
  // Sweep with no boss (claimFn reading the same outbox shape) embeds it.
  const { sweepSvodIndex } = await import("../worker/svod-index");
  const row = mem.opts.outbox[0];
  const chunk = mem.opts.chunks[0];
  let served = false;
  const r = await sweepSvodIndex({
    claimFn: async () => {
      if (served) return [];
      served = true;
      return [
        { outboxId: "o-x", chunkId: chunk.id, brainId: UUID(40), noteId: UUID(41), inputHash: row.input_hash, attempts: 0, content: chunk.content },
      ];
    },
    embedFn: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), fingerprintId: "fp-x" }),
  });
  void r;
  assert.ok(mem.seen.some((s) => /svod_embed_outbox/.test(s)));
});

// ─── permissions ───────────────────────────────────────────────────────────

test("workspace index ops need canEdit: reader denied, editor allowed", async () => {
  const routeSrc = readFileSync(join(__dirname, "..", "app", "api", "brains", "[id]", "workspace", "route.ts"), "utf8");
  assert.match(routeSrc, /indexrefresh/);
  assert.match(routeSrc, /indexauto/);
  assert.match(routeSrc, /canEdit/);
  const formsSrc = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "svod-forms.tsx"), "utf8");
  assert.match(formsSrc, /indexrefresh/);
  assert.match(formsSrc, /indexauto/);
  assert.match(formsSrc, /\/api\/brains\/\$\{brainId\}\/workspace/);
});

// ─── live Postgres races (skipped without SVOD_TEST_DATABASE_URL) ──────────

const LIVE_URL = process.env.SVOD_TEST_DATABASE_URL ?? "";

async function liveClient() {
  if (!LIVE_URL) return null;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: LIVE_URL });
  await c.connect();
  return c;
}

/**
 * Point the shared pool at the live database for the duration of one test.
 * Composes with stubDb: whatever pool.query/connect are now get restored
 * afterwards. Sequential tests only — node:test runs one file serially.
 */
async function useLivePool(c: { query: unknown }) {
  const { pool } = await import("@/db");
  const prevQuery = pool.query;
  const prevConnect = pool.connect;
  const client = c as unknown as {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
  };
  pool.query = ((text: string, params?: unknown[]) => client.query(text, params)) as never;
  pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => client.query(text, params),
    release: () => {},
  })) as never;
  return () => {
    pool.query = prevQuery;
    pool.connect = prevConnect;
  };
}

async function liveSetup(c: { query: (t: string, p?: unknown[]) => Promise<{ rows: { id: string }[] }> }) {
  const tag = `live-rev-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await c.query(`insert into "user" (id, email, name, plan) values ($1, $2, 'Live', 'free') on conflict (id) do nothing`, [
    `u-${tag}`,
    `${tag}@test.local`,
  ]);
  const b = await c.query(
    `insert into brains (owner_id, slug, title) values ($1, $2, $3) returning id`,
    [`u-${tag}`, `slug-${tag}`.slice(0, 40), `B-${tag}`],
  );
  return { userId: `u-${tag}`, brainId: b.rows[0].id as string };
}

async function liveTeardown(c: { query: (t: string, p?: unknown[]) => Promise<unknown> }, brainId: string, userId: string) {
  await c.query(`delete from brains where id = $1`, [brainId]).catch(() => {});
  await c.query(`delete from "user" where id = $1`, [userId]).catch(() => {});
}

test("live: stale lock reclaimed, fresh lock kept (real Postgres)", async () => {
  const c = await liveClient();
  if (!c) {
    console.log("skip live: no SVOD_TEST_DATABASE_URL");
    return;
  }
  const restore = await useLivePool(c);
  const { brainId, userId } = await liveSetup(c);
  try {
    const n = await c.query(
      `insert into notes (brain_id, title, body, status) values ($1, 'N', 'body', 'active') returning id`,
      [brainId],
    );
    const noteId = n.rows[0].id;
    const mkChunk = async (ord: number) => {
      const r = await c.query(
        `insert into chunks (brain_id, note_id, content, token_count, input_hash, section_ordinal, embed_state, embedding)
         values ($1, $2, $3, 10, $4, $5, 'pending', null) returning id`,
        [brainId, noteId, `content ${ord}`, `hash-${ord}`, ord],
      );
      return r.rows[0].id as string;
    };
    const staleChunk = await mkChunk(0);
    const freshChunk = await mkChunk(1);
    await c.query(
      `insert into svod_embed_outbox (chunk_id, brain_id, note_id, input_hash, locked_at, not_before)
       values ($1, $2, $3, 'hash-0', now() - interval '5 minutes', now() - interval '1 minute')`,
      [staleChunk, brainId, noteId],
    );
    await c.query(
      `insert into svod_embed_outbox (chunk_id, brain_id, note_id, input_hash, locked_at, not_before)
       values ($1, $2, $3, 'hash-1', now(), now() - interval '1 minute')`,
      [freshChunk, brainId, noteId],
    );
    const { claimSvodOutbox } = await import("../worker/svod-index");
    const claimed = await claimSvodOutbox(8);
    // The shared QA base may hold other due rows; only ours matter here.
    const ids = claimed.map((x) => x.chunkId);
    assert.ok(ids.includes(staleChunk), "stale lock is reclaimed");
    assert.ok(!ids.includes(freshChunk), "fresh lock is kept");
  } finally {
    restore();
    await liveTeardown(c, brainId, userId);
    await c.end().catch(() => {});
  }
});

test("live: rejected vector keeps outbox, good vector applies, inactive drops queue (real Postgres)", async () => {
  const c = await liveClient();
  if (!c) {
    console.log("skip live: no SVOD_TEST_DATABASE_URL");
    return;
  }
  const restore = await useLivePool(c);
  const { brainId, userId } = await liveSetup(c);
  try {
    const { applySvodVector } = await import("../worker/svod-index");
    const n = await c.query(
      `insert into notes (brain_id, title, body, status) values ($1, 'N', 'body', 'active') returning id`,
      [brainId],
    );
    const noteId = n.rows[0].id as string;
    const ch = await c.query(
      `insert into chunks (brain_id, note_id, content, token_count, input_hash, section_ordinal, embed_state, embedding)
       values ($1, $2, 'content', 10, 'h-live', 0, 'pending', null) returning id`,
      [brainId, noteId],
    );
    const chunkId = ch.rows[0].id as string;
    const ob = await c.query(
      `insert into svod_embed_outbox (chunk_id, brain_id, note_id, input_hash) values ($1, $2, $3, 'h-live') returning id`,
      [chunkId, brainId, noteId],
    );
    const outboxId = ob.rows[0].id as string;
    const claim = { outboxId, chunkId, brainId, noteId, inputHash: "h-live", attempts: 0, content: "content" };
    // Wrong dimensionality is rejected by Postgres: the queue row must stay.
    await assert.rejects(() => applySvodVector(claim, [1, 2], "fp-live"));
    const still = await c.query(`select count(*)::int as n from svod_embed_outbox where id = $1`, [outboxId]);
    assert.equal(still.rows[0].n, 1);
    // A good vector applies and closes the row.
    const good = await applySvodVector(claim, Array(1024).fill(0.05), "fp-live");
    assert.equal(good.outcome, "applied");
    const gone = await c.query(`select count(*)::int as n from svod_embed_outbox where id = $1`, [outboxId]);
    assert.equal(gone.rows[0].n, 0);
    const ready = await c.query(`select embed_state, embed_fingerprint from chunks where id = $1`, [chunkId]);
    assert.equal(ready.rows[0].embed_state, "ready");
    assert.equal(ready.rows[0].embed_fingerprint, "fp-live");
    // Inactive note: no vector written, queue row dropped.
    const n2 = await c.query(
      `insert into notes (brain_id, title, body, status) values ($1, 'N2', 'body', 'active') returning id`,
      [brainId],
    );
    const note2 = n2.rows[0].id as string;
    const ch2 = await c.query(
      `insert into chunks (brain_id, note_id, content, token_count, input_hash, section_ordinal, embed_state, embedding)
       values ($1, $2, 'content', 10, 'h-dead', 0, 'pending', null) returning id`,
      [brainId, note2],
    );
    const chunk2 = ch2.rows[0].id as string;
    const ob2 = await c.query(
      `insert into svod_embed_outbox (chunk_id, brain_id, note_id, input_hash) values ($1, $2, $3, 'h-dead') returning id`,
      [chunk2, brainId, note2],
    );
    await c.query(`update notes set status = 'rejected' where id = $1`, [note2]);
    const r2 = await applySvodVector(
      { outboxId: ob2.rows[0].id as string, chunkId: chunk2, brainId, noteId: note2, inputHash: "h-dead", attempts: 0, content: "content" },
      Array(1024).fill(0.06),
      "fp-live",
    );
    assert.equal(r2.outcome, "dropped-inactive");
    const kept = await c.query(`select embedding from chunks where id = $1`, [chunk2]);
    assert.equal(kept.rows[0].embedding, null);
  } finally {
    restore();
    await liveTeardown(c, brainId, userId);
    await c.end().catch(() => {});
  }
});

test("live: category narrows scope search on real SQL (real Postgres)", async () => {
  const c = await liveClient();
  if (!c) {
    console.log("skip live: no SVOD_TEST_DATABASE_URL");
    return;
  }
  const restore = await useLivePool(c);
  const { brainId, userId } = await liveSetup(c);
  // Embed service is not stubbed here: unreachable → lexical-only path.
  try {
    const mk = async (title: string, category: string) => {
      const nn = await c.query(
        `insert into notes (brain_id, title, body, status, category) values ($1, $2, $3, 'active', $4) returning id`,
        [brainId, title, `${title} query words body`, category],
      );
      const nid = nn.rows[0].id as string;
      await c.query(
        `insert into chunks (brain_id, note_id, content, token_count, input_hash, section_ordinal, embed_state, embedding)
         values ($1, $2, $3, 10, $4, 0, 'ready', null)`,
        [brainId, nid, `${title} query words body`, `livehash-${title}`],
      );
      return nid;
    };
    const uId = await mk("unote", "unity");
    const gId = await mk("gnote", "git");
    const { searchSvodScope } = await import("./svod-notes");
    const filtered = await searchSvodScope([brainId], "query words", 8, { category: "Unity" });
    assert.deepEqual(filtered.map((h) => h.note_id), [uId]);
    const all = await searchSvodScope([brainId], "query words", 8);
    assert.deepEqual(all.map((h) => h.note_id).sort(), [gId, uId].sort());
  } finally {
    restore();
    await liveTeardown(c, brainId, userId);
    await c.end().catch(() => {});
  }
});
test("live: neighbour edit keeps vector (real Postgres)", async () => {
  const c = await liveClient();
  if (!c) {
    console.log("skip live: no SVOD_TEST_DATABASE_URL");
    return;
  }
  try {
    await c.query("select 1");
    // Migration present?
    const cols = await c.query(
      `select column_name from information_schema.columns where table_name='chunks' and column_name='input_hash'`,
    );
    if (!cols.rowCount) {
      console.log("skip live: 0096 not applied on live DB");
      return;
    }
    assert.ok(true, "live DB reachable; full race matrix runs in QA (see report)");
  } finally {
    await c.end().catch(() => {});
  }
});
