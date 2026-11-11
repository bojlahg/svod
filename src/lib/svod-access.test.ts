import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  policyForRole,
  roleRank,
  normalizeEmail,
  isOperatorEmailPure,
} from "./svod-access";

test("role hierarchy is reader < editor < reviewer < owner", () => {
  assert.ok(roleRank("reader") < roleRank("editor"));
  assert.ok(roleRank("editor") < roleRank("reviewer"));
  assert.ok(roleRank("reviewer") < roleRank("owner"));
  assert.equal(roleRank(null), 0);
});

test("access matrix: reader sees active only, editor edits, reviewer reviews, owner admins", () => {
  const reader = policyForRole("reader", false);
  assert.equal(reader.canRead, true);
  assert.equal(reader.canEdit, false);
  assert.equal(reader.canReview, false);
  assert.equal(reader.canAdmin, false);

  const editor = policyForRole("editor", false);
  assert.equal(editor.canRead, true);
  assert.equal(editor.canEdit, true);
  assert.equal(editor.canReview, false);
  assert.equal(editor.canAdmin, false);

  const reviewer = policyForRole("reviewer", false);
  assert.equal(reviewer.canRead, true);
  assert.equal(reviewer.canEdit, true);
  assert.equal(reviewer.canReview, true);
  assert.equal(reviewer.canAdmin, false);

  const owner = policyForRole("owner", false);
  assert.deepEqual(
    [owner.canRead, owner.canEdit, owner.canReview, owner.canAdmin],
    [true, true, true, true],
  );

  const none = policyForRole(null, false);
  assert.deepEqual([none.canRead, none.canEdit, none.canReview, none.canAdmin], [
    false,
    false,
    false,
    false,
  ]);
});

test("operator can administer any base regardless of grant", () => {
  const op = policyForRole(null, true);
  assert.deepEqual([op.canRead, op.canEdit, op.canReview, op.canAdmin], [true, true, true, true]);
  assert.equal(op.isOperator, true);
});

test("email is normalized consistently", () => {
  assert.equal(normalizeEmail("  Admin@Example.COM  "), "admin@example.com");
});

test("operator identity is env email, case-insensitive", () => {
  assert.equal(isOperatorEmailPure("Admin@Example.com", "admin@example.com", undefined), true);
  assert.equal(
    isOperatorEmailPure("ops@example.com", "", "OPS@example.com"),
    true,
  );
  assert.equal(isOperatorEmailPure("user@example.com", "admin@example.com", undefined), false);
  assert.equal(isOperatorEmailPure(null, "admin@example.com", undefined), false);
});

test("0093 migration migrates only unambiguous verified grants", () => {
  const sql = readFileSync(join(__dirname, "..", "db", "migrations", "0093_svod_access.sql"), "utf8");
  // Stable per-user table with the three SVOD roles.
  assert.match(sql, /create table if not exists brain_members/);
  assert.match(sql, /check \(role in \('reader', 'editor', 'reviewer'\)\)/);
  assert.match(sql, /unique \(brain_id, user_id\)/);
  // Verified identity only, ambiguous case-fold duplicates excluded.
  assert.match(sql, /"emailVerified"/);
  assert.match(sql, /lower\(u\.email\) = lower\(g\.email\)/);
  assert.match(sql, /not exists/);
  // Legacy role mapping is explicit.
  assert.match(sql, /when 'viewer' then 'reader' else 'editor'/);
  // Strip line comments before asserting on code: the header documents what
  // is NOT migrated, so the words appear in prose but must not appear as
  // consulted tables/columns.
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(!/purchases/.test(code), "migration must not grant via purchases");
  assert.ok(!/pack/.test(code), "migration must not grant via packs");
  assert.ok(!/library/.test(code), "migration must not grant via library");
  assert.ok(!/members/.test(code.replace(/brain_members/g, "")), "migration must not grant via members");
  assert.ok(!/visibility\s*=/.test(code), "migration must not grant via visibility");
});
