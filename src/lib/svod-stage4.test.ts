import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stubDb } from "./test-db";
import {
  getTokenCapability,
  tokenCanCreateProject,
  validateProjectId,
  grantableCapabilities,
  resolveTokenBrain,
  listTokenBrains,
} from "./svod-token-scopes";
import { validateNoteBody } from "./svod-notes";
import { writeAgentNote } from "./agent-write";
import { callTool } from "./mcp";
import type { TokenOwner } from "./tokens";

/**
 * SVOD stage 4 focused tests + live-review regressions (points 1-11).
 */

const UUID = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0").slice(-2)}`;
const TOKEN = "22222222-2222-4222-8222-222222222222";
const USER = "user-1";
const BRAIN_GENERAL = UUID(10);
const BRAIN_PROJECT = UUID(11);

function brainRow(over: Record<string, unknown> = {}) {
  return {
    id: BRAIN_GENERAL,
    owner_id: USER,
    slug: "unity",
    title: "Unity",
    goal: "Answer Unity questions.",
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
    note_count: 1,
    source_count: 0,
    price_cents: 0,
    sales_count: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

test("0095 migration: token scopes, project_id, revision target, native composite FK", () => {
  const sql = readFileSync(join(__dirname, "..", "db", "migrations", "0095_svod_scopes.sql"), "utf8");
  assert.match(sql, /create table if not exists mcp_token_scopes/);
  assert.match(sql, /unique \(token_id, brain_id\)/);
  assert.match(sql, /check \(capability in \('read', 'propose', 'write'\)\)/);
  assert.match(sql, /can_create_project/);
  assert.match(sql, /brains_project_id_key/);
  assert.match(sql, /where project_id is not null/);
  assert.match(sql, /enforce_brain_project_immutable/);
  assert.match(sql, /project_id is immutable/);
  assert.match(sql, /notes_bump_revision/);
  assert.match(sql, /new\.revision = old\.revision \+ 1/);
  assert.match(sql, /target_note_id/);
  assert.match(sql, /target_revision/);
  assert.match(sql, /notes_brain_id_key.*unique \(brain_id, id\)/s);
  assert.match(sql, /notes_target_scope_fk/);
  assert.match(sql, /foreign key \(brain_id, target_note_id\) references notes \(brain_id, id\)/);
  assert.match(sql, /references mcp_tokens\(id\) on delete set null/);
  assert.match(sql, /enforce_token_scope_project_write/);
  assert.match(sql, /direct-write grant requires a project base/);
  assert.ok(!/enforce_proposal_same_brain/.test(sql), "child-only trigger replaced by composite FK");
  assert.ok(!/target_version timestamptz/.test(sql), "timestamp version replaced by integer revision");
  const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.ok(!/update notes set body/i.test(code), "migration must not touch note bodies");
  assert.ok(!/delete from notes/i.test(code), "migration must not delete notes");
  assert.ok(!/update brains set title/i.test(code), "migration must not rewrite brains");
});

test("project_id validation: trimmed, bounded, no line breaks", () => {
  assert.deepEqual(validateProjectId("  my-proj  "), { ok: true, projectId: "my-proj" });
  assert.equal(validateProjectId("").ok, false);
  assert.equal(validateProjectId("   ").ok, false);
  assert.equal(validateProjectId("x".repeat(201)).ok, false);
  assert.equal(validateProjectId("a\nb").ok, false);
});

test("default deny: unknown token capability is null (fail closed)", async () => {
  stubDb((text) => {
    if (/from mcp_token_scopes s/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await getTokenCapability(TOKEN, BRAIN_GENERAL), null);
});

test("revoked token has no capability (live check, immediate)", async () => {
  stubDb((text) => {
    if (/from mcp_token_scopes s/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await getTokenCapability(TOKEN, BRAIN_GENERAL), null);
});

test("read/propose/write differ; write needs project + current canEdit", async () => {
  const caps = ["read", "propose", "write"] as const;
  for (const cap of caps) {
    stubDb((text, params) => {
      if (/select \* from brains where id/.test(text)) {
        const isProject = params[0] === BRAIN_PROJECT;
        return [brainRow({ id: params[0], project_id: isProject ? "proj-1" : null })];
      }
      if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
      if (/from brain_members where brain_id/.test(text)) return [];
      if (/from mcp_token_scopes s/.test(text) && /s\.brain_id = \$2/.test(text)) return [{ capability: cap }];
      throw new Error(`unexpected query: ${text}`);
    });
    const general = await resolveTokenBrain(BRAIN_GENERAL, USER, TOKEN);
    assert.equal(general?.canRead, true, `${cap} general canRead`);
    assert.equal(general?.canPropose, cap !== "read", `${cap} general canPropose`);
    assert.equal(general?.canDirectWrite, false, `${cap} general never direct-writes`);
    const project = await resolveTokenBrain(BRAIN_PROJECT, USER, TOKEN);
    // Owner has canEdit, so write counts on project.
    assert.equal(project?.canDirectWrite, cap === "write", `${cap} project direct-write (owner)`);
  }
});

test("role downgrade disables old write token (reader with write grant cannot direct-write)", async () => {
  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) {
      return [brainRow({ id: params[0], project_id: "proj-1", owner_id: "owner-other" })];
    }
    if (/select email from "user" where id/.test(text)) return [{ email: "reader@x.test" }];
    if (/from brain_members where brain_id/.test(text)) return [{ role: "reader" }];
    if (/from mcp_token_scopes s/.test(text)) return [{ capability: "write" }];
    throw new Error(`unexpected query: ${text}`);
  });
  const acc = await resolveTokenBrain(BRAIN_PROJECT, "user-reader", TOKEN);
  assert.equal(acc?.capability, "write");
  assert.equal(acc?.userCanEdit, false);
  assert.equal(acc?.canDirectWrite, false);
});

test("membership removal disables direct-write (no user access, uniform null)", async () => {
  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) {
      return [brainRow({ id: params[0], project_id: "proj-1", owner_id: "owner-other" })];
    }
    if (/select email from "user" where id/.test(text)) return [{ email: "ex@x.test" }];
    if (/from brain_members where brain_id/.test(text)) return [];
    if (/from mcp_token_scopes s/.test(text)) return [{ capability: "write" }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await resolveTokenBrain(BRAIN_PROJECT, "user-ex", TOKEN), null);
});

test("direct-write general denial even with forged write flag (DB-trusted project check)", async () => {
  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0], project_id: null })];
    if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
    if (/from brain_members where brain_id/.test(text)) return [];
    if (/from mcp_token_scopes s/.test(text)) return [{ capability: "write" }];
    throw new Error(`unexpected query: ${text}`);
  });
  const acc = await resolveTokenBrain(BRAIN_GENERAL, USER, TOKEN);
  assert.equal(acc?.capability, "write");
  assert.equal(acc?.canDirectWrite, false);
});

test("OAuth (non-UUID tokenId) fails closed without explicit grants", async () => {
  let touched = false;
  stubDb(() => {
    touched = true;
    return [];
  });
  assert.equal(await resolveTokenBrain(BRAIN_GENERAL, USER, "oauth"), null);
  assert.equal(touched, false, "malformed tokenId must not touch the database");
  assert.equal(await tokenCanCreateProject("oauth"), false);
});

test("create-project is separate default-off capability", async () => {
  stubDb((text) => {
    if (/can_create_project from mcp_tokens/.test(text)) return [{ can_create_project: false }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await tokenCanCreateProject(TOKEN), false);
  stubDb((text) => {
    if (/can_create_project from mcp_tokens/.test(text)) return [{ can_create_project: true }];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.equal(await tokenCanCreateProject(TOKEN), true);
});

test("ordinary issuer grants intersect membership; admin may grant any base", async () => {
  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0] })];
    if (/select email from "user" where id/.test(text)) return [{ email: "reader@x.test" }];
    if (/from brain_members where brain_id/.test(text)) return [{ role: "reader" }];
    throw new Error(`unexpected query: ${text}`);
  });
  const reader = await grantableCapabilities(BRAIN_GENERAL, "user-reader");
  assert.deepEqual(reader.allowed, ["read"]);

  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0], project_id: "p1" })];
    if (/select email from "user" where id/.test(text)) return [{ email: "editor@x.test" }];
    if (/from brain_members where brain_id/.test(text)) return [{ role: "editor" }];
    throw new Error(`unexpected query: ${text}`);
  });
  const editorProj = await grantableCapabilities(BRAIN_PROJECT, "user-editor");
  assert.ok(editorProj.allowed.includes("write"));

  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0], project_id: null })];
    if (/select email from "user" where id/.test(text)) return [{ email: "editor@x.test" }];
    if (/from brain_members where brain_id/.test(text)) return [{ role: "editor" }];
    throw new Error(`unexpected query: ${text}`);
  });
  const editorGen = await grantableCapabilities(BRAIN_GENERAL, "user-editor");
  assert.ok(!editorGen.allowed.includes("write"), "general bases never grant write");
});

test("known-ID denial is uniform: ungranted UUID reads as missing", async () => {
  const owner: TokenOwner = { userId: USER, tokenId: TOKEN, plan: "free", canCreateProject: false };
  stubDb((text, params) => {
    if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
    if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0] })];
    if (/from brain_members where brain_id/.test(text)) return [];
    if (/from mcp_token_scopes s/.test(text)) return [];
    if (/from brains b/.test(text) && /mcp_token_scopes/.test(text)) return [];
    if (/select \* from notes/.test(text)) {
      throw new Error("must not fetch note data before the token boundary");
    }
    return [];
  });
  const out = await callTool("brain_read", { brain: BRAIN_GENERAL, note_id: UUID(99) }, owner);
  assert.equal(out.isError, true);
  assert.match(out.text, /No brain/);
});

test("read-only/propose-only cannot direct-write a project base", async () => {
  const owner: TokenOwner = { userId: USER, tokenId: TOKEN, plan: "free", canCreateProject: false };
  for (const cap of ["read", "propose"] as const) {
    stubDb((text, params) => {
      if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
      if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0], project_id: "proj-1", slug: "proj" })];
      if (/select \* from brains where owner_id/.test(text)) return [];
      if (/from brain_members where brain_id/.test(text)) return [];
      if (/from mcp_token_scopes s/.test(text) && /s\.brain_id = \$2/.test(text)) return [{ capability: cap }];
      if (/from brains b/.test(text) && /mcp_token_scopes/.test(text)) return [];
      return [];
    });
    const out = await callTool(
      "project_note_create",
      { brain: BRAIN_PROJECT, title: "Map", body: "Hello" },
      owner,
    );
    assert.equal(out.isError, true, `${cap} must not direct-write`);
    assert.match(out.text, /cannot direct-write/);
  }
});

test("brain_create without project_id is refused (project-only entry point)", async () => {
  const owner: TokenOwner = { userId: USER, tokenId: TOKEN, plan: "free", canCreateProject: true };
  stubDb(() => []);
  const out = await callTool("brain_create", { title: "Thematic", goal: "legacy goal" }, owner);
  assert.equal(out.isError, true);
  assert.match(out.text, /project_id|project bases only/i);
});

test("brain_create without create capability tells agent to keep Markdown in reply", async () => {
  const owner: TokenOwner = { userId: USER, tokenId: TOKEN, plan: "free", canCreateProject: false };
  stubDb((text) => {
    if (/from brains where project_id/.test(text)) return [];
    if (/can_create_project from mcp_tokens/.test(text)) return [{ can_create_project: false }];
    throw new Error(`unexpected query: ${text}`);
  });
  const out = await callTool("brain_create", { title: "Proj", project_id: "ext-1" }, owner);
  assert.equal(out.isError, true);
  assert.match(out.text, /prepared Markdown in your reply/i);
});

test("proposal bodies preserve BOM/CRLF/whitespace literally with tail marker", async () => {
  const tail = "TAIL-MARKER-8472";
  const body = "﻿# Title\r\n\r\n  spaced   lines  \r\n```js\nx();\n```\r\n" + tail;
  stubDb((text) => {
    if (/insert into notes/.test(text)) return [{ id: UUID(50) }];
    if (/select id from folders/.test(text)) return [];
    if (/select id from brains/.test(text)) return [{ id: BRAIN_GENERAL }];
    if (/update brains set content_changed_at/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  const v = validateNoteBody(body);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.body, body);
    assert.equal(v.body.length, body.length);
    assert.ok(v.body.endsWith(tail));
    assert.ok(v.body.includes("\r\n"));
    assert.ok(v.body.startsWith("﻿"));
  }
});

test("writeAgentNote preserves 25k bodies literally (no 20k slice)", async () => {
  const tail = "END-2599";
  const body = `﻿${"x".repeat(25500)}\r\n${tail}`;
  assert.ok(body.length > 20000);
  stubDb((text, params) => {
    if (/insert into notes/.test(text)) {
      const savedBody = params[3] as string;
      assert.equal(savedBody, body);
      assert.equal(savedBody.length, body.length);
      assert.ok(savedBody.endsWith(tail));
      return [{ id: UUID(51) }];
    }
    if (/select id from brains where id/.test(text)) return [{ id: BRAIN_GENERAL }];
    if (/update brains set content_changed_at/.test(text)) return [];
    return [];
  });
  const brain = brainRow() as never;
  const r = await writeAgentNote(
    brain,
    { pending: true, agentClient: "mcp", proposedBy: USER, tokenId: TOKEN },
    { title: "Big note", body },
  );
  assert.equal(r.status, "saved");
});

test("oversize bodies are visibly rejected, never silently truncated", async () => {
  const body = "y".repeat(100_001);
  stubDb(() => {
    throw new Error("must not touch the database on validation failure");
  });
  const brain = brainRow() as never;
  const r = await writeAgentNote(
    brain,
    { pending: true, agentClient: "mcp", proposedBy: USER, tokenId: TOKEN },
    { title: "Too big", body },
  );
  assert.equal(r.status, "rejected");
  assert.match((r as { reason: string }).reason, /too long|max/i);
});

test("project_note_update distinguishes omitted from empty (empty is invalid)", async () => {
  const owner: TokenOwner = { userId: USER, tokenId: TOKEN, plan: "free", canCreateProject: false };
  stubDb((text, params) => {
    if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
    if (/select \* from brains where id/.test(text)) return [brainRow({ id: params[0], project_id: "proj-1" })];
    if (/select \* from brains where owner_id/.test(text)) return [];
    if (/from brain_members where brain_id/.test(text)) return [];
    if (/from mcp_token_scopes s/.test(text) && /s\.brain_id = \$2/.test(text)) return [{ capability: "write" }];
    if (/select title, body from notes/.test(text)) return [{ title: "Cur", body: "Current body" }];
    return [];
  });
  const emptyTitle = await callTool(
    "project_note_update",
    { brain: BRAIN_PROJECT, note_id: UUID(60), title: "   ", body: "New body here" },
    owner,
  );
  assert.equal(emptyTitle.isError, true);
  const emptyBody = await callTool(
    "project_note_update",
    { brain: BRAIN_PROJECT, note_id: UUID(60), title: "New title", body: "   " },
    owner,
  );
  assert.equal(emptyBody.isError, true);
});

test("unchanged old version stays while a pending edit exists (revision contract)", async () => {
  const src = readFileSync(join(__dirname, "svod-proposals.ts"), "utf8");
  assert.match(src, /insert into notes.*target_note_id/s);
  assert.match(src, /target_revision/);
  assert.ok(!/target_version/.test(src), "timestamp version removed");
  assert.match(src, /revision/);
  assert.match(src, /remains pending|changed after this proposal/i);
  // Stage 5: section sync reconciles chunks in the same tx (legacy direct
  // delete+chunksForNote replaced by hash-stable syncSvodSections).
  assert.match(src, /syncSvodSections/);
  assert.match(src, /expectedProposalRevision/);
  assert.match(src, /expectedSourceBrainId/);
});

test("reviewer approval guards proposal revision + source brain at tx boundary", async () => {
  const src = readFileSync(join(__dirname, "svod-proposals.ts"), "utf8");
  assert.match(src, /for update/);
  assert.match(src, /where id = \$1 and status = 'pending' for update/);
  assert.match(src, /proposal\.revision !==/);
  assert.match(src, /superseded_by/);
  assert.match(src, /moved-edit/);
});

test("token issuance is atomic with visible feedback (no swallowed tx errors)", async () => {
  const src = readFileSync(join(__dirname, "..", "app", "settings", "tokens", "actions.ts"), "utf8");
  assert.ok(!/catch \{\s*\/\/.*skip/s.test(src), "no silent scope catch");
  assert.match(src, /Nothing was (issued|changed)/);
  assert.match(src, /for update/);
  assert.match(src, /revoked_at is null for update/);
  const form = readFileSync(join(__dirname, "..", "app", "settings", "tokens", "TokenScopesForm.tsx"), "utf8");
  assert.match(form, /useActionState/);
  assert.match(form, /role="alert"/);
});

test("mcp entry point explains project map vs proposals without retired handoff/exam", async () => {
  const rpc = readFileSync(join(__dirname, "mcp-rpc.ts"), "utf8");
  assert.ok(!/brain_handoff/.test(rpc), "retired handoff removed from instructions");
  assert.ok(!/scored against an exam/.test(rpc), "exam prerequisite removed");
  assert.match(rpc, /project_note_create \/ project_note_update/);
  assert.match(rpc, /prepared Markdown in your reply/);
});

test("token UI never renders plaintext of an existing token", async () => {
  const page = readFileSync(join(__dirname, "..", "app", "settings", "tokens", "page.tsx"), "utf8");
  assert.ok(!/token\.token[^s]/.test(page.replace(/issued\.token|state\.token/g, "")), "list must show prefix only");
  assert.match(page, /prefix/);
  const form = readFileSync(join(__dirname, "..", "app", "settings", "tokens", "TokenForm.tsx"), "utf8");
  assert.match(form, /only time the token is shown/i);
});

test("reviewer UI submits shown versions and displays current on conflict", async () => {
  const page = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "page.tsx"), "utf8");
  // Sidebar is compact (no per-row comparison/forms); full comparison lives in
  // the selected right-pane proposal view with complete bodies.
  assert.ok(!/Show original \/ proposed changes/.test(page), "sidebar comparison removed (compact queue)");
  assert.match(page, /Current accepted \(full\)/);
  assert.match(page, /Proposed \(full\)/);
  assert.match(page, /pendingPage/);
  assert.match(page, /Older/);
  assert.match(page, /proposalRevision=\{selected\.revision\}/);
  assert.match(page, /expectedSourceBrainId=\{selected\.brain_id\}/);
  const form = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "proposal-review-form.tsx"), "utf8");
  assert.match(form, /MARKDOWN_HELP_EXAMPLES/);
  assert.match(form, /SvodMarkdown/);
  assert.match(form, /expectedProposalRevision/);
  assert.match(form, /expectedSourceBrainId/);
  assert.match(form, /Current accepted version \(conflict/);
  assert.match(form, /foldersByBrain/);
  const actions = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "review-actions.ts"), "utf8");
  assert.match(actions, /expectedProposalRevision/);
  assert.match(actions, /expectedSourceBrainId/);
  assert.ok(!/void res;/.test(actions), "conflict feedback is returned, not discarded");
  assert.ok(!/approveNotePlain/.test(actions), "no unversioned plain approval path");
  assert.ok(!/Back-compat path/.test(actions), "no unversioned compatibility branch in actions");
});

test("remote actions require shown versions (forged omission refused)", async () => {
  const actions = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "review-actions.ts"), "utf8");
  assert.match(actions, /Stale view: reload the queue and resubmit the shown versions/);
  const svc = readFileSync(join(__dirname, "svod-proposals.ts"), "utf8");
  assert.match(svc, /Stale view: reload the queue and resubmit the shown versions/);
});

test("cross-base moves default to destination root with scoped validation", async () => {
  const svc = readFileSync(join(__dirname, "svod-proposals.ts"), "utf8");
  assert.match(svc, /Cross-base default: destination root/);
  assert.match(svc, /select id from folders where id = \$1 and brain_id = \$2 for update/);
  const form = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "proposal-review-form.tsx"), "utf8");
  assert.match(form, /foldersByBrain/);
  assert.match(form, /__root/);
});

test("moved edits keep the submitted title unchanged with history attribution", async () => {
  const svc = readFileSync(join(__dirname, "svod-proposals.ts"), "utf8");
  assert.ok(!/Moved edit of/.test(svc), "stored title stays as submitted");
  assert.match(svc, /superseded_reason/);
  assert.match(svc, /moved edit to base/);
});

test("successful approval navigates to the accepted note in its destination base", async () => {
  const actions = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "review-actions.ts"), "utf8");
  // Same-base edit (target ID in source), new-note (proposal ID), and both
  // cross-base variants (new + moved edit in dest) all land on res.noteId in
  // the resolved destination base; conflicts return with the proposal kept.
  assert.match(actions, /redirect\(`\/brains\/\$\{finalBrainId\}\?note=\$\{acceptedId\}`\)/);
  assert.match(actions, /const finalBrainId = destBrainId \?\? note\.brain_id/);
  assert.ok(!/return \{ ok: true as const \};\n\}\n\nexport async function editProposalAction/.test(actions), "no dead approve success branch");
  const form = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "proposal-review-form.tsx"), "utf8");
  assert.ok(!/Approved\./.test(form), "no dead Approved state after navigation");
});

test("pendingPage is clamped before SQL OFFSET (repeated/non-numeric/overflow safe)", async () => {
  const page = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "page.tsx"), "utf8");
  assert.match(page, /MAX_PENDING_PAGE/);
  assert.match(page, /Math\.min\(pendingPageRaw, MAX_PENDING_PAGE\)/);
  assert.match(page, /firstParam\(raw\.pendingPage\)/);
  assert.match(page, /limit 20 offset \$2/);
});

test("reviewer save with only form newline normalization preserves stored BOM+LF bytes", async () => {
  const { editProposal } = await import("./svod-proposals");
  const BRAIN = UUID(30);
  const PID = UUID(70);
  const TID = UUID(71);
  const LF = "﻿# Review note\n\n- item one\n- item two\n\n```js\ncode();\n```\n  trailing spaces  \nTAIL-7F3A";
  const CRLF = LF.replace(/\n/g, "\r\n");
  assert.notEqual(CRLF, LF);
  const proposalRow = {
    id: PID, brain_id: BRAIN, title: "Review note", body: LF, revision: 3,
    target_note_id: TID, target_revision: 5, folder_id: null, status: "pending",
  };
  const targetRow = { title: "Target", body: "target body", revision: 5 };
  let writtenBody: unknown = null;
  stubDb((text, params) => {
    if (/select \* from notes where id = \$1 and brain_id = \$2 and status = 'pending' for update/.test(text)) {
      return [proposalRow];
    }
    if (/select title, body, revision from notes where id = \$1 and brain_id = \$2/.test(text)) {
      return [targetRow];
    }
    if (/update notes set title = \$3, body = \$4, target_revision/.test(text)) {
      writtenBody = params[3];
      return [{ ...proposalRow, title: params[2], body: params[3] }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const res = await editProposal({
    brainId: BRAIN, proposalId: PID, title: "Review note", body: CRLF,
    expectedProposalRevision: 3, expectedTargetRevision: 5,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.proposal.body, LF);
    assert.equal(res.proposal.body.length, LF.length);
    assert.ok(res.proposal.body.startsWith("﻿"), "BOM preserved");
    assert.ok(res.proposal.body.endsWith("TAIL-7F3A"), "tail marker preserved");
  }
  assert.equal(writtenBody, LF);
});

test("approval without saving writes stored BOM+LF bytes to the target", async () => {
  const { approveProposal } = await import("./svod-proposals");
  const BRAIN = UUID(30);
  const PID = UUID(70);
  const TID = UUID(71);
  const LF = "﻿# Review note\n\n- item one\n- item two\n\n```js\ncode();\n```\n  trailing spaces  \nTAIL-7F3A";
  const CRLF = LF.replace(/\n/g, "\r\n");
  assert.notEqual(CRLF, LF);
  const proposalRow = {
    id: PID, brain_id: BRAIN, title: "Review note", body: LF, revision: 3,
    target_note_id: TID, target_revision: 5, folder_id: null, status: "pending",
    proposed_by: USER, token_id: TOKEN,
  };
  const targetRow = { id: TID, title: "Target", body: "old target body", revision: 5 };
  let targetBody: unknown = null;
  const chunkContents: string[] = [];
  stubDb((text, params) => {
    if (/select \* from notes where id = \$1 and status = 'pending' for update/.test(text)) {
      return [proposalRow];
    }
    if (/select id from brains where id = \$1 for update/.test(text)) return [{ id: BRAIN }];
    if (/select id, title, body, revision from notes/.test(text)) return [targetRow];
    if (/update notes set folder_id = \$3, title = \$4, body = \$5, updated_token_id/.test(text)) {
      targetBody = params[4];
      return [];
    }
    // Stage 5 section sync (replaces the legacy delete+chunksForNote pair).
    if (/select auto_index from brains/.test(text)) return [{ auto_index: false }];
    if (/from chunks\s+where note_id/.test(text)) return [];
    if (/delete from chunks where id/.test(text)) return [];
    if (/update chunks set section_ordinal/.test(text)) return [];
    if (/insert into chunks/.test(text)) {
      chunkContents.push(String(params[2]));
      return [{ id: `c${chunkContents.length}` }];
    }
    if (/svod_embed_outbox/.test(text)) return [];
    if (/delete from chunks where note_id/.test(text)) return [];
    if (/insert into chunks \(brain_id, note_id, content, token_count, embedding\)/.test(text)) {
      chunkContents.push(String(params[2]));
      return [];
    }
    if (/update notes set status = 'superseded'/.test(text)) return [];
    if (/update brains set content_changed_at/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  const res = await approveProposal({
    proposalId: PID, title: "Review note", body: CRLF,
    expectedProposalRevision: 3, expectedSourceBrainId: BRAIN,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.noteId, TID);
  assert.equal(targetBody, LF);
  assert.equal((targetBody as string).length, LF.length);
  assert.ok((targetBody as string).startsWith("﻿"), "target BOM preserved");
  assert.ok((targetBody as string).endsWith("TAIL-7F3A"), "target tail preserved");
  assert.ok(chunkContents.length > 0, "chunks written from final content");
  assert.ok(!chunkContents.join("").includes("\r"), "chunks match preserved LF bytes");
});

test("reviewer save with only lone-CR form normalization preserves stored bytes", async () => {
  const { editProposal } = await import("./svod-proposals");
  const BRAIN = UUID(30);
  const PID = UUID(72);
  const TID = UUID(73);
  const CR = "﻿# Proposed\r\rline one\rline two\rTAIL-CR1A";
  // Browsers submit every newline variant (CR, LF, CRLF) as CRLF.
  const SUBMITTED = CR.replace(/\r\n|\r|\n/g, "\r\n");
  assert.notEqual(SUBMITTED, CR);
  const proposalRow = {
    id: PID, brain_id: BRAIN, title: "Proposed", body: CR, revision: 3,
    target_note_id: TID, target_revision: 5, folder_id: null, status: "pending",
  };
  const targetRow = { title: "Target", body: "target body", revision: 5 };
  let writtenBody: unknown = null;
  stubDb((text, params) => {
    if (/select \* from notes where id = \$1 and brain_id = \$2 and status = 'pending' for update/.test(text)) {
      return [proposalRow];
    }
    if (/select title, body, revision from notes where id = \$1 and brain_id = \$2/.test(text)) {
      return [targetRow];
    }
    if (/update notes set title = \$3, body = \$4, target_revision/.test(text)) {
      writtenBody = params[3];
      return [{ ...proposalRow, title: params[2], body: params[3] }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const res = await editProposal({
    brainId: BRAIN, proposalId: PID, title: "Proposed", body: SUBMITTED,
    expectedProposalRevision: 3, expectedTargetRevision: 5,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.proposal.body, CR);
    assert.equal(res.proposal.body.length, CR.length);
    assert.ok(!res.proposal.body.includes("\r\n"), "no CRLF rewrite of lone CR");
    assert.ok(res.proposal.body.endsWith("TAIL-CR1A"), "tail marker preserved");
  }
  assert.equal(writtenBody, CR);
});

test("edit/rebase revalidates the canonical base route, not just the posted slug", async () => {
  const actions = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "review-actions.ts"), "utf8");
  // The browser sits on /brains/<uuid> while the form posts the human slug;
  // other workspace actions invalidate both plus the index.
  assert.match(actions, /revalidateProposalScope\(note\.brain_id/);
  assert.match(actions, /revalidatePath\(`\/brains\/\$\{brainId\}`\)/);
  assert.match(actions, /revalidatePath\("\/brains"\)/);
  const editFn = actions.slice(actions.indexOf("export async function editProposalAction"));
  assert.ok(!/revalidatePath\(`\/brains\/\$\{String\(formData\.get\("slug"\)\)\}`\)/.test(editFn), "no slug-only revalidation on edit");
});

test("successful edit returns the new revision and the form refreshes it", async () => {
  const actions = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "review-actions.ts"), "utf8");
  assert.match(actions, /revision: res\.proposal\.revision/);
  const form = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "proposal-review-form.tsx"), "utf8");
  assert.match(form, /setExpectedRev\(res\.revision\)/);
  const page = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "page.tsx"), "utf8");
  // Stable proposal-ID key: a revision-key remount would discard local
  // Saved/error/draft state after its own response and erase the draft on
  // another reviewer's update. expectedRev advances from the returned revision
  // and is retained on conflict until explicit refresh/review.
  assert.match(page, /key=\{selected\.id\}/);
  assert.ok(!page.includes("selected.id}:${selected.revision}"), "no revision-key remount");
});

test("edit feedback settles with the response, independent of router transition", async () => {
  const form = readFileSync(join(__dirname, "..", "app", "brains", "[slug]", "proposal-review-form.tsx"), "utf8");
  // Awaited directly: the settled return value clears pending and shows
  // feedback even when the revalidation refetch is slow. Nothing announces
  // success before the response arrives.
  assert.match(form, /await editProposalAction\(null, fd\)/);
  assert.match(form, /finally \{\s*setEditPending\(false\);\s*\}/);
  assert.match(form, /value=\{expectedRev\}/);
  // Pre-hydration/native submit must not leak the hidden Markdown body into a
  // GET URL; the JavaScript direct-await flow is unchanged.
  assert.match(form, /<form method="post" onSubmit=\{onEditSubmit\}/);
  assert.ok(!/useActionState\(editProposalAction/.test(form), "edit no longer hangs on the transition dispatcher");
  assert.match(form, /Could not save\. Check the connection and retry\./);
});

test("listTokenBrains intersects user and token (revoke/grant applies immediately)", async () => {
  stubDb((text) => {
    if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
    if (/from brains b/.test(text) && /mcp_token_scopes/.test(text)) {
      return [{ ...brainRow(), owner_handle: "u", capability: "read" }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const rows = await listTokenBrains(USER, TOKEN);
  assert.equal(rows.length, 1);
  stubDb((text) => {
    if (/select email from "user" where id/.test(text)) return [{ email: `${USER}@x.test` }];
    if (/from brains b/.test(text) && /mcp_token_scopes/.test(text)) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  assert.deepEqual(await listTokenBrains(USER, TOKEN), []);
});
