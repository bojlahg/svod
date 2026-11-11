import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool } from "./mcp";
import { stubDb } from "./test-db";
import type { TokenOwner } from "./tokens";

const owner: TokenOwner = {
  userId: "u1",
  tokenId: "11111111-1111-4111-8111-111111111111",
  plan: "free",
  canCreateProject: false,
};

/**
 * SVOD stage 4: the refusal shelf is user ACL ∩ live token scope
 * (mcp_token_scopes) — no library, no catalogue. Legacy unscoped tokens see
 * an empty shelf with a grant hint.
 */
function shelfOnly(rows: object[]) {
  return (text: string) => {
    // listTokenBrains: operator check + scoped list.
    if (/select email from "user" where id/.test(text)) return [{ email: "u1@example.test" }];
    if (/from brains b/.test(text) && /mcp_token_scopes/.test(text)) {
      return rows.map((r, i) => ({
        id: `22222222-2222-4222-8222-2222222222${String(i).padStart(2, "0").slice(-2)}`,
        // Different owner so handles render namespaced ("mozg/slug") as the
        // tests expect; the token scope still grants them.
        owner_id: "other-user",
        slug: (r as { handle: string }).handle.includes("/")
          ? (r as { handle: string }).handle.split("/")[1]
          : (r as { handle: string }).handle,
        title: (r as { title: string }).title,
        goal: null,
        color: "amber",
        topic: "other",
        parent_id: null,
        visibility: "private",
        license: "nc",
        score: null,
        score_at: null,
        score_closed: null,
        delta: null,
        review_required: true,
        contributions: true,
        cover_key: null,
        kind: "knowledge",
        project_id: null,
        note_count: 0,
        source_count: 0,
        price_cents: 0,
        sales_count: 0,
        created_at: new Date(0),
        updated_at: new Date(0),
        owner_handle: "mozg",
        capability: "read",
        member_role: "owner",
      }));
    }
    // resolveBrain misses: no brain rows, no member rows, no token grant.
    if (/from brains/.test(text)) return [];
    if (/from brain_members/.test(text)) return [];
    if (/from mcp_token_scopes/.test(text)) return [];
    return [];
  };
}

test("a wrong handle is answered with the shelf, nearest first", async () => {
  stubDb(
    shelfOnly([
      { handle: "mozg/slot-engine", title: "Slot engine" },
      { handle: "riso-print-style", title: "Riso print style" },
    ]),
  );

  const out = await callTool("brain_brief", { brain: "mozg/riso-print-illustration-style" }, owner);

  assert.equal(out.isError, true);
  assert.match(out.text, /No brain "mozg\/riso-print-illustration-style" is available/);
  // Both offered, and the one sharing "riso"/"print" leads.
  assert.ok(out.text.indexOf("riso-print-style") < out.text.indexOf("mozg/slot-engine"));
});

test("a missing brain argument is named as missing, not as a brain called \"\"", async () => {
  stubDb(shelfOnly([{ handle: "mozg/slot-engine", title: "Slot engine" }]));

  const out = await callTool("brain_brief", {}, owner);

  assert.equal(out.isError, true);
  assert.doesNotMatch(out.text, /No brain ""/);
  assert.match(out.text, /needs a brain name/);
  assert.match(out.text, /mozg\/slot-engine/);
});

test("an empty shelf says how to fill it instead of listing nothing", async () => {
  stubDb(shelfOnly([]));

  const out = await callTool("brain_brief", { brain: "whatever" }, owner);

  assert.equal(out.isError, true);
  assert.match(out.text, /brain_create/);
  // SVOD: no catalogue pointer on an empty shelf.
  assert.doesNotMatch(out.text, /explore/);
  // Stage 4: transition hint for unscoped tokens.
  assert.match(out.text, /\/settings\/tokens/);
});

test("a brain you hold two ways is offered once", async () => {
  stubDb(
    shelfOnly([
      { handle: "mozg/slot-studio", title: "Slot studio" },
      { handle: "mozg/slot-studio", title: "Slot studio" },
      { handle: "mozg/pixijs-casino", title: "PixiJS casino" },
    ]),
  );

  const out = await callTool("brain_brief", { brain: "mozg/nope" }, owner);

  const hits = out.text.split("mozg/slot-studio").length - 1;
  assert.equal(hits, 1, `offered ${hits} times:\n${out.text}`);
  assert.match(out.text, /mozg\/pixijs-casino/);
});

test("onePerHandle keeps the first row, which is the truer relationship", async () => {
  const { onePerHandle } = await import("./mcp");
  assert.deepEqual(
    onePerHandle([
      { handle: "a", access: "buyer" },
      { handle: "a", access: "added" },
      { handle: "b", access: "added" },
    ]),
    [
      { handle: "a", access: "buyer" },
      { handle: "b", access: "added" },
    ],
  );
});

test("SVOD: brain_find is retired — no catalogue search without a grant", async () => {
  stubDb(() => []);
  const out = await callTool("brain_find", { question: "how do I fold a paper crane" }, owner);
  assert.equal(out.isError, true);
  assert.match(out.text, /Unknown tool: brain_find/);
});

test("SVOD: brain_find validation lives behind the retired tool", async () => {
  stubDb(() => []);
  const out = await callTool("brain_find", { question: "hi" }, owner);
  assert.equal(out.isError, true);
  assert.match(out.text, /Unknown tool: brain_find/);
});

test("brain_find accepts the argument name its sibling tool uses", async () => {
  stubDb(() => []);
  const out = await callTool("brain_find", { query: "how do cascading reels settle" }, owner);
  // Retired: the dispatcher answers before any argument handling.
  assert.match(out.text, /Unknown tool: brain_find/);
});

test("SVOD: gen_project is retired — project memory arrives in stage 4", async () => {
  stubDb(() => []);
  const out = await callTool("gen_project", { id: "p1" }, owner);
  assert.equal(out.isError, true);
  assert.match(out.text, /Unknown tool: gen_project/);
});

test("SVOD stage 4: scoped tools are offered with the new workflow", async () => {
  stubDb(() => []);
  const { TOOLS } = await import("./mcp-tools");
  const names = TOOLS.map((t) => t.name);
  for (const expected of [
    "brain_list",
    "brain_brief",
    "brain_search",
    "brain_read",
    "brain_write",
    "brain_write_batch",
    "brain_create",
    "brain_propose_edit",
    "project_note_create",
    "project_note_update",
  ]) {
    assert.ok(names.includes(expected), `${expected} is offered`);
  }
  const write = TOOLS.find((t) => t.name === "brain_write")!;
  assert.match(write.description, /proposal/i);
  const create = TOOLS.find((t) => t.name === "project_note_create")!;
  assert.match(create.description, /direct-write/i);
  assert.match(create.description, /general base/i);
});
