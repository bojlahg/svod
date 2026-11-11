import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { credKey64, credKeyForUser, credKeyForEmail } from "./cred-lock";

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function prefixOf(key: string): bigint {
  return BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 16)}`);
}

/** A key whose sha256 prefix has the high bit set must still fit int8. */
test("advisory keys always fit signed bigint, even with the high bit set", () => {
  let highBit: string | null = null;
  for (let i = 0; i < 500 && !highBit; i++) {
    const candidate = `svod:cred:user:probe-${i}`;
    if (prefixOf(candidate) >= 1n << 63n) highBit = candidate;
  }
  assert.ok(highBit, "expected a high-bit fixture within 500 probes");
  for (const key of ["svod:cred:user:u1", highBit]) {
    const v = BigInt(credKey64(key));
    assert.ok(v >= INT64_MIN && v <= INT64_MAX, `${key} -> ${v} out of int8 range`);
  }
  assert.equal(credKey64("abc"), credKey64("abc"));
  assert.equal(credKeyForUser("u1"), "svod:cred:user:u1");
  assert.equal(credKeyForEmail("  A@Example.COM "), "svod:cred:email:a@example.com");
});
