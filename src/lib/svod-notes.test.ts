import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDb } from "./test-db";
import { policyForRole } from "./svod-access";
import { validateNoteTitle, validateNoteBody, decodeMdBytes, searchSvodNotes } from "./svod-notes";
import { downloadFileParts } from "./svod-download";

/**
 * SVOD stage 3 regression:
 * - original bytes preserved (BOM/CRLF/whitespace/fences, NUL rejected)
 * - unchanged saves are no-ops (vectors + chunk IDs survive)
 * - lexical search dedupes per note BEFORE limit, active-only, same base
 * - reader cannot mutate (policy), moves keep IDs (no rewrite)
 * - body/status and chunks stay atomic (single tx in implementation)
 */

test("note validation preserves original bytes: BOM/CRLF/whitespace kept, NUL rejected", () => {
  const body = "﻿# Рецепт\r\n\r\n```csharp\r\nvar btn = new Button();\r\n```\r\n\r\n  spaced   lines  \r\n";
  const v = validateNoteBody(body);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.body, body);
    assert.ok(v.body.includes("\r\n"), "CRLF preserved");
    assert.ok(v.body.includes("﻿"), "BOM preserved");
    assert.ok(v.body.includes("  spaced   lines"), "whitespace preserved");
  }
  assert.equal(validateNoteBody("a\0b").ok, false);
  assert.equal(validateNoteTitle("  ").ok, false);
  assert.equal(validateNoteBody("   ").ok, false);
});

test("upload decoder preserves BOM+CRLF bytes exactly; fatal on invalid UTF-8", () => {
  // Real upload path: BOM + "# " + CRLF + Cyrillic, as raw input bytes.
  const input = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x0d, 0x0a, 0xd0, 0x9f]);
  const decoded = decodeMdBytes(input);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    // Byte equality, not a source-text match: re-encoding must reproduce input.
    assert.deepEqual(Buffer.from(decoded.text, "utf8"), input);
    assert.ok(decoded.text.startsWith("﻿"), "BOM marker kept, not stripped");
    assert.ok(decoded.text.includes("\r\n"), "CRLF kept, not normalised");
    // The stored body then passes validation untouched.
    const v = validateNoteBody(decoded.text);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.body, decoded.text);
  }
  // Lone continuation byte is invalid UTF-8 → fatal, visibly denied.
  const bad = decodeMdBytes(Buffer.from([0x23, 0x20, 0xd0]));
  assert.equal(bad.ok, false);
});

test("empty base entry point offers .md upload to editors", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "page.tsx"), "utf8");
  const emptyMarker = src.indexOf("Select a note on the left");
  assert.ok(emptyMarker !== -1);
  const selectedUpload = src.indexOf("canEdit && selected && !editing");
  assert.ok(selectedUpload !== -1);
  // An upload control lives in the empty/base view (before the selected-only
  // upload section), so a fresh base can receive its first .md.
  const emptyUpload = src.indexOf("SvodUpload", emptyMarker);
  assert.ok(emptyUpload !== -1 && emptyUpload < selectedUpload, "empty view must render SvodUpload");
  // Gated on canEdit: the nearest gate before it opens after the empty marker.
  const gate = src.lastIndexOf("{canEdit && (", emptyUpload);
  assert.ok(gate > emptyMarker, "empty-view upload stays editor-only");
  // No selected note there: folder falls back from focused folder to root.
  assert.match(src.slice(emptyMarker, selectedUpload), /currentFolder=\{validFolderFocus\}/);
});

test("reader can only view: policy denies mutations", () => {
  assert.equal(policyForRole("reader", false).canRead, true);
  assert.equal(policyForRole("reader", false).canEdit, false);
  assert.equal(policyForRole("editor", false).canEdit, true);
  assert.equal(policyForRole("reviewer", false).canReview, true);
  assert.equal(policyForRole(null, false).canRead, false);
});

test("lexical search dedupes per note before LIMIT and stays active/scoped", async () => {
  const seen: string[] = [];
  stubDb((text) => {
    seen.push(text);
    if (/from chunks/.test(text)) {
      // Per-note dedup before the limit (window fn), active-only, same base.
      assert.match(text, /row_number\(\) over \(/);
      assert.match(text, /partition by n\.id/);
      assert.match(text, /n\.status = 'active'/);
      assert.match(text, /c\.brain_id = \$1/);
      assert.match(text, /limit \$3/);
      return [
        { note_id: "n1", title: "Moon button", folder_id: null, excerpt: "best", rank: "0.9" },
        { note_id: "n2", title: "Moon latch", folder_id: null, excerpt: "good", rank: "0.5" },
      ];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const sql = seen;
  void sql;
  const hits = await searchSvodNotes("11111111-1111-4111-8111-111111111111", "moon button", 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].note_id, "n1");
  assert.equal(hits[0].excerpt, "best");
  assert.ok(seen.some((s) => /to_tsquery\('simple'/.test(s)), "uses lexical tsquery, no embeddings");
});

test("malformed brain ID returns nothing without SQL", async () => {
  let called = false;
  stubDb(() => {
    called = true;
    return [];
  });
  assert.deepEqual(await searchSvodNotes("not-a-uuid", "moon", 2), []);
  assert.equal(called, false);
});

test("unchanged save is a no-op in implementation: no chunk rewrite", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(__dirname, "svod-notes.ts"), "utf8");
  const start = src.indexOf("export async function updateSvodNote");
  const next = src.indexOf("export async function", start + 1);
  const fn = src.slice(start, next === -1 ? undefined : next);
  assert.match(fn, /status = 'active'/);
  assert.match(fn, /bodyUnchanged/);
  // Early return before any chunk delete/insert.
  const early = fn.slice(0, fn.indexOf("delete from chunks"));
  assert.match(early, /return same/);
});

test("move keeps ID: implementation updates folder_id only (no delete+insert)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(__dirname, "svod-notes.ts"), "utf8");
  const start = src.indexOf("export async function moveSvodNote");
  const next = src.indexOf("export async function", start + 1);
  const moveFn = src.slice(start, next === -1 ? undefined : next);
  assert.match(moveFn, /update notes set folder_id/);
  assert.match(moveFn, /status = 'active'/);
  assert.ok(!/delete from notes/.test(moveFn), "move must not delete the note");
  assert.ok(!/insert into notes/.test(moveFn), "move must not re-insert the note");
  assert.ok(!/delete from chunks/.test(moveFn), "move must not rewrite chunks");
});

test("writes are atomic: note change + chunk rewrite land in one transaction", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(__dirname, "svod-notes.ts"), "utf8");
  for (const fn of ["createSvodNote", "updateSvodNote", "moveSvodNote", "deleteSvodNote"]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`));
    assert.ok(/tx\(async/.test(body.slice(0, 2500)), `${fn} must run in tx()`);
  }
  assert.match(src, /embedding\)\s*values \([^)]*null\)/);
});

test("Cyrillic download filename is ByteString-safe with encoded filename*", () => {
  const { header, asciiName } = downloadFileParts("Заметка про Луну", "11111111-1111-4111-8111-111111111111");
  assert.ok(/^[\x20-\x7E]*$/.test(`attachment; filename="${asciiName}"`), "fallback is ASCII");
  assert.match(header, /filename\*=UTF-8''/);
  // Percent-encoded UTF-8 round-trips to the original title.
  const enc = header.split("filename*=UTF-8''")[1];
  assert.equal(decodeURIComponent(enc), "Заметка про Луну.md");
  assert.ok(!/["\r\n]/.test(asciiName));
});
