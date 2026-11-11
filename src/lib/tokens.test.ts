import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  burstExceeded,
  hashToken,
  issueLimitReached,
  issueToken,
  quotaRemaining,
  verifyToken,
} from "./tokens";
import { stubDb } from "./test-db";
import { PLANS } from "./plans";

test("hashToken is sha256, never the plaintext", () => {
  const token = "mzg_abc123";
  const hash = hashToken(token);
  assert.equal(hash, createHash("sha256").update(token).digest("hex"));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
  assert.ok(!hash.includes(token));
});

test("issueToken stores only the hash, returns the plaintext once", async () => {
  let stored: unknown[] = [];
  stubDb((text, params) => {
    if (/insert into mcp_tokens/.test(text)) {
      stored = params;
      return [{ id: "tok-1" }];
    }
    throw new Error(`unexpected query: ${text}`);
  });

  const issued = await issueToken("u1", "laptop");
  assert.match(issued.token, /^mzg_/);
  assert.equal(issued.prefix, issued.token.slice(0, 12));
  assert.equal(issued.id, "tok-1");

  // Column order in the insert: user_id, token_hash, prefix, name.
  assert.equal(stored[0], "u1");
  assert.equal(stored[1], hashToken(issued.token));
  assert.notEqual(stored[1], issued.token);
  assert.equal(stored[2], issued.prefix);
  assert.equal(stored[3], "laptop");
});

test("verifyToken resolves a live token to its owner", async () => {
  const token = "mzg_" + "a".repeat(32);
  stubDb((text) => {
    if (/from mcp_tokens t/.test(text)) {
      return [
        {
          id: "tok-1",
          user_id: "u1",
          token_hash: hashToken(token),
          plan: "pro",
          can_create_project: false,
        },
      ];
    }
    if (/update mcp_tokens set last_used_at/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });

  const solo = { userId: "u1", tokenId: "tok-1", plan: "pro", canCreateProject: false };
  assert.deepEqual(await verifyToken(`Bearer ${token}`), solo);
  // The bare token works too, not just the Authorization-header form.
  assert.deepEqual(await verifyToken(token), solo);
});


test("verifyToken rejects unknown and revoked tokens", async () => {
  // The lookup filters revoked_at is null, so both cases are simply no row.
  stubDb((text) => {
    if (/from mcp_tokens t/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await verifyToken("mzg_" + "b".repeat(32)), null);
});

test("verifyToken rejects malformed tokens without touching the database", async () => {
  stubDb(() => {
    throw new Error("the database must not be queried for a malformed token");
  });
  assert.equal(await verifyToken(null), null);
  assert.equal(await verifyToken(""), null);
  assert.equal(await verifyToken("sk-not-our-prefix"), null);
});

test("quotaRemaining is the plan's monthly limit minus this month's calls", async () => {
  stubDb((text) => {
    if (/date_trunc\('month'/.test(text)) return [{ used: 5 }];
    throw new Error(`unexpected query: ${text}`);
  });
  // Read from PLANS rather than repeated here: the numbers move when the pricing
  // moves, and a test that hardcodes them fails for the wrong reason.
  assert.equal(await quotaRemaining("u1", "free"), PLANS.free.calls - 5);
  assert.equal(await quotaRemaining("u1", "pro"), PLANS.pro.calls - 5);
});

test("quotaRemaining never goes negative", async () => {
  stubDb((text) => {
    if (/date_trunc\('month'/.test(text)) return [{ used: 9999 }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await quotaRemaining("u1", "free"), 0);
});

test("burstExceeded trips at 60 calls in the last minute", async () => {
  stubDb((text) => {
    if (/interval '1 minute'/.test(text)) return [{ n: 59 }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await burstExceeded("u1"), false);

  stubDb((text) => {
    if (/interval '1 minute'/.test(text)) return [{ n: 60 }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await burstExceeded("u1"), true);
});

test("issueLimitReached caps live tokens at 20", async () => {
  stubDb((text) => {
    if (/from mcp_tokens\s+where user_id/.test(text)) return [{ n: 19 }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await issueLimitReached("u1"), false);

  stubDb((text) => {
    if (/from mcp_tokens\s+where user_id/.test(text)) return [{ n: 20 }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await issueLimitReached("u1"), true);
});
