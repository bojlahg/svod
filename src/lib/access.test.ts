import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain } from "@/db/types";
import { accessFor } from "./access";
import { stubDb } from "./test-db";

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const READER = "user-reader";
const EDITOR = "user-editor";
const REVIEWER = "user-reviewer";

type MemberRole = "reader" | "editor" | "reviewer";

let brainSeq = 0;
function brain(over: Partial<Brain>): Brain {
  brainSeq += 1;
  // Stable resolvers validate UUIDs before touching the database, so
  // fixtures use real-shaped IDs.
  const id = `11111111-1111-4111-8111-1111111111${String(brainSeq).padStart(2, "0").slice(-2)}`;
  return {
    id,
    owner_id: OWNER,
    slug: `brain-${brainSeq}`,
    title: `Brain ${brainSeq}`,
    goal: null,
    color: "#000000",
    topic: "other",
    parent_id: null,
    visibility: "private",
    license: "proprietary",
    score: null,
    score_at: null,
    score_closed: null,
    delta: null,
    review_required: false,
    contributions: true,
    cover_key: null,
    kind: "knowledge",
    note_count: 0,
    source_count: 0,
    price_cents: 0,
    sales_count: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

/**
 * SVOD stage 2 stub: brains + brain_members + user emails.
 * No grants, purchases, packs, or visibility backdoors — the policy under
 * test must not consult them.
 */
function stubSvodDb(opts: {
  brains: Brain[];
  members?: { brain_id: string; user_id: string; role: MemberRole }[];
  emails?: Record<string, string>;
}) {
  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) {
      const row = opts.brains.find((b) => b.id === params[0]);
      return row ? [row] : [];
    }
    if (/select email from "user" where id/.test(text)) {
      const id = params[0] as string;
      const email = opts.emails?.[id] ?? `${id}@example.test`;
      return [{ email }];
    }
    if (/from brain_members where brain_id/.test(text)) {
      const m = (opts.members ?? []).find(
        (x) => x.brain_id === params[0] && x.user_id === params[1],
      );
      return m ? [{ role: m.role }] : [];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

test("unknown brain resolves to null", async () => {
  stubSvodDb({ brains: [] });
  assert.equal(await accessFor("brain-missing", OWNER), null);
});

test("private brain: owner is owner, everyone else gets nothing", async () => {
  const b = brain({ visibility: "private" });
  stubSvodDb({ brains: [b] });

  assert.deepEqual(await accessFor(b.id, OWNER), { brain: b, access: "owner", preview: false });
  assert.deepEqual(await accessFor(b.id, STRANGER), { brain: b, access: null, preview: false });
  assert.deepEqual(await accessFor(b.id, null), { brain: b, access: null, preview: false });
});

test("SVOD: public visibility grants nothing without a member row", async () => {
  const b = brain({ visibility: "public", price_cents: 900 });
  stubSvodDb({ brains: [b] });

  // A migrated public row must not expose content to strangers or anonymous.
  assert.deepEqual(await accessFor(b.id, STRANGER), { brain: b, access: null, preview: false });
  assert.deepEqual(await accessFor(b.id, null), { brain: b, access: null, preview: false });
  assert.deepEqual(await accessFor(b.id, OWNER), { brain: b, access: "owner", preview: false });
});

test("SVOD: member roles map reader->viewer, editor/reviewer->contributor", async () => {
  const b = brain({ visibility: "private" });
  stubSvodDb({
    brains: [b],
    members: [
      { brain_id: b.id, user_id: READER, role: "reader" },
      { brain_id: b.id, user_id: EDITOR, role: "editor" },
      { brain_id: b.id, user_id: REVIEWER, role: "reviewer" },
    ],
  });

  assert.deepEqual(await accessFor(b.id, READER), { brain: b, access: "viewer", preview: false });
  assert.deepEqual(await accessFor(b.id, EDITOR), {
    brain: b,
    access: "contributor",
    preview: false,
  });
  assert.deepEqual(await accessFor(b.id, REVIEWER), {
    brain: b,
    access: "contributor",
    preview: false,
  });
});

test("SVOD: no preview state — ungranted readers get access null, not a storefront", async () => {
  const b = brain({ visibility: "public", price_cents: 900 });
  stubSvodDb({ brains: [b] });
  const found = await accessFor(b.id, STRANGER);
  assert.equal(found?.preview, false);
  assert.equal(found?.access, null);
});
