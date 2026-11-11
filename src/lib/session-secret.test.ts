import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsableSecret, resolveSessionSecret, secretFilePath } from "./session-secret";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "svod-secret-"));
}

const GOOD = "a".repeat(64);

test("new file is created and stable across calls", () => {
  const dir = freshDir();
  const env: Record<string, string | undefined> = {};
  const first = resolveSessionSecret(env, dir);
  assert.equal(first.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(first));
  const file = secretFilePath(env, dir);
  assert.ok(existsSync(file));
  const second = resolveSessionSecret(env, dir);
  assert.equal(second, first);
  assert.equal(readFileSync(file, "utf8"), first);
});

test("usable secret from env wins and does not touch the file", () => {
  const dir = freshDir();
  const env: Record<string, string | undefined> = { BETTER_AUTH_SECRET: GOOD };
  const out = resolveSessionSecret(env, dir);
  assert.equal(out, GOOD);
  assert.ok(!existsSync(secretFilePath(env, dir)));
});

test("example and short secrets fall back to the file", () => {
  for (const bad of ["", "short", "example", "change-me-openssl-rand-hex-32", "build-time-placeholder-not-a-secret"]) {
    const dir = freshDir();
    const env: Record<string, string | undefined> = { BETTER_AUTH_SECRET: bad };
    const out = resolveSessionSecret(env, dir);
    assert.equal(out.length, 64);
    assert.ok(!bad || out !== bad);
    assert.ok(existsSync(secretFilePath(env, dir)));
  }
});

test("second call reads what is already written", () => {
  const dir = freshDir();
  const env: Record<string, string | undefined> = {};
  const file = secretFilePath(env, dir);
  writeFileSync(file, `  ${GOOD}  \n`);
  assert.equal(resolveSessionSecret(env, dir), GOOD);
  // Short garbage is replaced, then stable.
  writeFileSync(file, "junk");
  const generated = resolveSessionSecret(env, dir);
  assert.equal(generated.length, 64);
  assert.equal(resolveSessionSecret(env, dir), generated);
});

test("SVOD_SECRET_FILE override is honoured", () => {
  const dir = freshDir();
  const custom = join(dir, "custom-secret");
  const env: Record<string, string | undefined> = { SVOD_SECRET_FILE: custom };
  const first = resolveSessionSecret(env, dir);
  assert.equal(readFileSync(custom, "utf8"), first);
  assert.equal(resolveSessionSecret(env, dir), first);
});

test("generated file is private (0600) when the platform supports it", () => {
  if (process.platform === "win32") return;
  const dir = freshDir();
  const out = resolveSessionSecret({}, dir);
  assert.equal(out.length, 64);
  const mode = statSync(secretFilePath({}, dir)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("isUsableSecret rejects placeholders", () => {
  assert.equal(isUsableSecret(undefined), false);
  assert.equal(isUsableSecret("short"), false);
  assert.equal(isUsableSecret("example"), false);
  assert.equal(isUsableSecret("change-me-openssl-rand-hex-32"), false);
  assert.equal(isUsableSecret("build-time-placeholder-not-a-secret"), false);
  assert.equal(isUsableSecret(`xx-example-${"y".repeat(30)}`), false);
  assert.equal(isUsableSecret(GOOD), true);
});
