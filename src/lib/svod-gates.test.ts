import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDb } from "./test-db";
import { brainAccessById, workspaceBrain, policyForRole } from "./svod-access";

/**
 * SVOD stage 2 gate regression: the same checks the routes rely on.
 *
 * - Cross-user: owner / granted reader / stranger / anonymous on one brain.
 * - Known-ID denial: a stranger holding the UUID still cannot read.
 * - Anonymous legacy entrances: null user grants nothing, even on a brain
 *   left `visibility = 'public'` by the old schema.
 * - Review queue visibility: only reviewer+ may review (the page hides
 *   pending from readers; the actions deny them here).
 */

const OWNER = "user-owner";
const READER = "user-reader";
const REVIEWER = "user-reviewer";
const STRANGER = "user-stranger";
const BRAIN = "11111111-1111-4111-8111-111111111111";

function stubGatesDb() {
  stubDb((text, params) => {
    if (/select \* from brains where id/.test(text)) {
      if (params[0] === BRAIN) {
        return [
          {
            id: BRAIN,
            owner_id: OWNER,
            slug: "unity",
            title: "Unity",
            goal: null,
            color: "amber",
            topic: "other",
            parent_id: null,
            visibility: "public",
            license: "nc",
            score: null,
            score_at: null,
            score_closed: null,
            delta: null,
            review_required: true,
            contributions: true,
            cover_key: null,
            kind: "knowledge",
            note_count: 1,
            source_count: 0,
            price_cents: 0,
            sales_count: 0,
            created_at: new Date(0),
            updated_at: new Date(0),
          },
        ];
      }
      return [];
    }
    if (/select \* from brains where owner_id/.test(text)) {
      return [];
    }
    if (/select email from "user" where id/.test(text)) {
      return [{ email: `${params[0]}@example.test` }];
    }
    if (/from brain_members where brain_id/.test(text)) {
      const [, userId] = params as [string, string];
      if (userId === READER) return [{ role: "reader" }];
      if (userId === REVIEWER) return [{ role: "reviewer" }];
      return [];
    }
    if (/select role from brain_members/.test(text)) {
      return [];
    }
    if (/select \* from brains where slug/.test(text)) {
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  });
}

test("cross-user read: owner and granted reader pass, stranger and anonymous do not", async () => {
  stubGatesDb();
  assert.equal((await brainAccessById(BRAIN, OWNER))?.canRead, true);
  assert.equal((await brainAccessById(BRAIN, READER))?.canRead, true);
  assert.equal((await brainAccessById(BRAIN, STRANGER))?.canRead, false);
  assert.equal((await brainAccessById(BRAIN, null))?.canRead, false);
});

test("known-ID denial: a migrated public row exposes nothing to the ungranted", async () => {
  stubGatesDb();
  const stranger = await brainAccessById(BRAIN, STRANGER);
  assert.equal(stranger?.role, null);
  assert.equal(stranger?.canRead, false);
  assert.equal(stranger?.canEdit, false);
  assert.equal(stranger?.canReview, false);
  assert.equal(stranger?.canAdmin, false);
  const anon = await brainAccessById(BRAIN, null);
  assert.equal(anon?.canRead, false);
});

test("review queue: reader cannot review, reviewer can, owner can", async () => {
  assert.equal(policyForRole("reader", false).canReview, false);
  assert.equal(policyForRole("reviewer", false).canReview, true);
  assert.equal(policyForRole("owner", false).canReview, true);
});

test("workspaceBrain opens a base by stable ID for a granted user", async () => {
  stubGatesDb();
  const found = await workspaceBrain(BRAIN, READER);
  assert.equal(found?.canRead, true);
  assert.equal(found?.brain.id, BRAIN);
});

test("workspaceBrain denies a stranger even with the exact ID", async () => {
  stubGatesDb();
  // Denial is canRead === false (callers 404 on it) — the object still
  // carries which base was asked for, never its contents.
  assert.equal((await workspaceBrain(BRAIN, STRANGER))?.canRead, false);
});
