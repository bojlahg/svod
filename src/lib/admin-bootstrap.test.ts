import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAdminEnv } from "./admin-bootstrap";

/**
 * The bootstrap's database paths are covered by the repeatable live-Postgres
 * check (scripts/check-admin-bootstrap.ts — requires SVOD_TEST_DATABASE_URL).
 * What stays here is pure input validation, so `npm test` needs no database.
 */

test("validateAdminEnv accepts a normal pair", () => {
  const out = validateAdminEnv("Admin@Example.com", "correct horse 123");
  assert.equal(out.email, "Admin@Example.com");
  assert.equal(out.password, "correct horse 123");
});

test("validateAdminEnv rejects missing/invalid admin env clearly", () => {
  assert.throws(() => validateAdminEnv(undefined, undefined), /MOZG_ADMIN_EMAIL/);
  assert.throws(() => validateAdminEnv("", "long-enough-password"), /MOZG_ADMIN_EMAIL/);
  assert.throws(
    () => validateAdminEnv("not-an-email", "long-enough-password"),
    /MOZG_ADMIN_EMAIL/,
  );
  assert.throws(() => validateAdminEnv("a@b.com", undefined), /MOZG_ADMIN_PASSWORD/);
  assert.throws(() => validateAdminEnv("a@b.com", "short"), /MOZG_ADMIN_PASSWORD/);
  assert.throws(() => validateAdminEnv("a@b.com", "x".repeat(129)), /too long/);
});

test("validateAdminEnv preserves the password literally", () => {
  // No trim: leading/trailing spaces are part of the password better-auth
  // hashes, so trimming here would lock the admin out.
  const out = validateAdminEnv("a@b.com", "  s3cret-pw  ");
  assert.equal(out.password, "  s3cret-pw  ");
});

test("validation errors never echo the password", () => {
  const pw = "super-secret-pw-123";
  try {
    validateAdminEnv("bad-email", pw);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!String((err as Error).message).includes(pw));
  }
});
