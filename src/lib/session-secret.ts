import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Self-host session secret (SVOD stage 7).
 *
 * Pure Node (fs/path/crypto only) — no network, no @/lib/env, no @/lib/auth —
 * so the tiny print step can run before Next/better-auth ever see the env.
 *
 * Rules (release kit):
 * - a BETTER_AUTH_SECRET from the environment wins when it is at least 32
 *   chars and not an example; the file is neither read nor written then;
 * - otherwise the file wins: SVOD_SECRET_FILE, else <storageDir>/session-secret
 *   (production storageDir is /data/storage);
 * - a missing file or short garbage is replaced with 32 random bytes as
 *   hex (64 chars), written with 0600, and reused on the next call.
 */

export const EXAMPLE_SECRETS = new Set([
  "change-me-openssl-rand-hex-32",
  "build-time-placeholder-not-a-secret",
  "example",
  "test",
  "secret",
  "password",
]);

const EXAMPLE_RE = /example|change-me|placeholder/i;

export function isUsableSecret(value: string | undefined | null): boolean {
  if (!value) return false;
  if (value.length < 32) return false;
  if (EXAMPLE_SECRETS.has(value)) return false;
  if (EXAMPLE_RE.test(value)) return false;
  return true;
}

export function secretFilePath(
  env: Record<string, string | undefined> = process.env,
  storageDir?: string,
): string {
  const override = env.SVOD_SECRET_FILE?.trim();
  if (override) return override;
  const base =
    storageDir ?? env.STORAGE_LOCAL_DIR ?? "/data/storage";
  return join(base, "session-secret");
}

export function resolveSessionSecret(
  env: Record<string, string | undefined> = process.env,
  storageDir?: string,
): string {
  const fromEnv = env.BETTER_AUTH_SECRET ?? "";
  if (isUsableSecret(fromEnv)) return fromEnv;

  const file = secretFilePath(env, storageDir);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (isUsableSecret(existing)) return existing;
  } catch {
    // Missing or unreadable here means "generate below"; a real IO failure
    // on write still throws and fails the boot loudly.
  }

  const fresh = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fresh, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes (Windows CI); the content
    // is already written, and the container volume keeps it private.
  }
  return fresh;
}
