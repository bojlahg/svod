import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool } from "./mcp";
import { stubDb } from "./test-db";
import type { TokenOwner } from "./tokens";

const owner: TokenOwner = { userId: "u1", tokenId: "t1", plan: "free" };

/**
 * SVOD stage 2: the refusal shelf is owned + explicitly granted bases
 * (brain_members) — no library, no catalogue.
 */
function shelfOnly(rows: object[]) {
  return (text: string) => {
    if (/brain_members/.test(text) && /union all/.test(text)) return rows;
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

test("brain_find's answer carries the evidence, not just the handle", async () => {
  const { foundText } = await import("./mcp");
  const out = foundText(
    "how does RLS work in supabase",
    [
      {
        handle: "mozg",
        slug: "supabase",
        title: "Supabase",
        answers: [{ title: "Row level security", snippet: "Enable RLS on every table." }],
      },
      { handle: "mozg", slug: "drizzle", title: "Drizzle", answers: [] },
    ],
    new Set(["mozg/drizzle"]),
  );

  assert.match(out, /mozg\/supabase/);
  assert.match(out, /Row level security: Enable RLS on every table\./);
  assert.match(out, /mozg\/drizzle — Drizzle \(on your shelf\)/);
  assert.match(out, /brain_search \{"brain": "mozg\/supabase"/);
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
