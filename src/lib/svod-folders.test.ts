import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateFolderName,
  buildFolderTree,
  folderPath,
  ancestorChain,
  expandedForNote,
  isUuid,
  firstParam,
} from "./svod-folders";

test("folder names: bounded, no slash/backslash/line-breaks, no silent rewrite", () => {
  // Leading/trailing spaces rejected (not silently rewritten); interior kept.
  assert.equal(validateFolderName("  UI  ").ok, false);
  assert.equal(validateFolderName("").ok, false);
  assert.equal(validateFolderName("   ").ok, false);
  assert.equal(validateFolderName("a/b").ok, false);
  assert.equal(validateFolderName("a\\b").ok, false);
  assert.equal(validateFolderName("a\nb").ok, false);
  assert.equal(validateFolderName("a\rb").ok, false);
  assert.equal(validateFolderName(".").ok, false);
  assert.equal(validateFolderName("..").ok, false);
  assert.equal(validateFolderName("x".repeat(121)).ok, false);
  assert.deepEqual(validateFolderName("Moon.Controls"), { ok: true, name: "Moon.Controls" });
  // Interior whitespace preserved exactly (no collapsing).
  assert.deepEqual(validateFolderName("a  b"), { ok: true, name: "a  b" });
});

test("UUIDs validated before SQL; repeated params do not throw", () => {
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(firstParam("a"), "a");
  assert.equal(firstParam(["a", "b"]), "a");
  assert.equal(firstParam(undefined), "");
});

test("tree nests children under parents, sorted ru-aware", () => {
  const folders = [
    { id: "c", brain_id: "b", parent_id: "p", name: "Янтарь", created_at: new Date(0), updated_at: new Date(0) },
    { id: "g", brain_id: "b", parent_id: "c", name: "Moon.Controls", created_at: new Date(0), updated_at: new Date(0) },
    { id: "p", brain_id: "b", parent_id: null, name: "UI", created_at: new Date(0), updated_at: new Date(0) },
    { id: "b2", brain_id: "b", parent_id: "p", name: "Buttons", created_at: new Date(0), updated_at: new Date(0) },
  ];
  const tree = buildFolderTree(folders as never);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].folder.id, "p");
  assert.equal(tree[0].children.length, 2);
  // Non-empty nested branch: UI → Янтарь → Moon.Controls.
  const amber = tree[0].children.find((n) => n.folder.id === "c");
  assert.ok(amber);
  assert.equal(amber.children.length, 1);
  assert.equal(amber.children[0].folder.id, "g");
  assert.equal(amber.children[0].depth, 2);
});

test("folder path joins ancestors with /; root is empty", () => {
  const folders = [
    { id: "p", brain_id: "b", parent_id: null, name: "Unity", created_at: new Date(0), updated_at: new Date(0) },
    { id: "c", brain_id: "b", parent_id: "p", name: "UI", created_at: new Date(0), updated_at: new Date(0) },
    { id: "g", brain_id: "b", parent_id: "c", name: "Moon.Controls", created_at: new Date(0), updated_at: new Date(0) },
  ];
  assert.equal(folderPath(folders as never, null), "");
  assert.equal(folderPath(folders as never, "g"), "Unity / UI / Moon.Controls");
  assert.deepEqual(
    ancestorChain(folders as never, "g").map((f) => f.id),
    ["p", "c", "g"],
  );
  assert.deepEqual([...expandedForNote(folders as never, "g")], ["p", "c", "g"]);
});

test("0094 migration uses native composite same-base FKs and immutable scope", () => {
  const sql = readFileSync(join(__dirname, "..", "db", "migrations", "0094_svod_folders.sql"), "utf8");
  assert.match(sql, /create table if not exists folders/);
  assert.match(sql, /notes\.folder_id|add column if not exists folder_id/);
  // Referenced pair for the composite keys.
  assert.match(sql, /folders_brain_id_key/);
  assert.match(sql, /\(brain_id, id\)/);
  // Native composite guards (no scope triggers): parent + note folder.
  assert.match(sql, /folders_parent_scope_fk/);
  assert.match(sql, /notes_folder_scope_fk/);
  assert.match(sql, /foreign key \(brain_id, parent_id\) references folders \(brain_id, id\)/);
  assert.match(sql, /foreign key \(brain_id, folder_id\) references folders \(brain_id, id\)/);
  assert.match(sql, /on delete set null \(folder_id\)/);
  // Immutable brain/parent after creation (no moves → no cycles).
  assert.match(sql, /enforce_folder_immutable_scope/);
  assert.match(sql, /folder scope is immutable/);
  // Root + sibling uniqueness as two partial indexes (NULL never equals NULL).
  assert.match(sql, /folders_root_name_key/);
  assert.match(sql, /folders_sibling_name_key/);
  assert.match(sql, /where parent_id is null/);
  // Name hygiene incl. backslash.
  assert.match(sql, /position\('\\' in name\)/);
  // Existing notes stay at the root: nullable link, no backfill, no note rewrite.
  const code = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(!/update notes set folder_id/i.test(code), "migration must not rewrite existing notes");
  assert.ok(!/update notes set body/i.test(code), "migration must not touch note bodies");
  assert.ok(!/delete from notes/i.test(code), "migration must not delete notes");
  assert.ok(!/enforce_folder_scope/i.test(code.replace(/enforce_folder_immutable_scope/g, "")), "no move/cycle trigger");
});
