import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "@/lib/mcp-tools";
import { PLANS, PLAN_PRICE_CENTS } from "@/lib/plans";
import { PAGES, CURRENT_PAGE_MARKER } from "@/lib/pages";

// machine.ts validates process env at import; nothing here opens a connection.
process.env.DATABASE_URL ??= "postgres://localhost:5432/mozg-test";

const load = () => import("./machine");

/**
 * The sheet's whole claim is that it cannot disagree with the product, so the
 * test is not "does it render" — it is "does every name and number the modules
 * enforce actually reach it". A tool added to the MCP surface and forgotten
 * here would otherwise leave agents a list that quietly lies.
 */
test("the sheet names every tool, page and plan ceiling the product enforces", async () => {
  const { machineDoc } = await load();
  const doc = machineDoc();

  for (const tool of TOOLS) {
    assert.ok(doc.includes(tool.name), `missing tool ${tool.name}`);
  }
  for (const page of PAGES) {
    assert.ok(doc.includes(page.path), `missing page ${page.path}`);
  }

  // Numbers, in the form a reader sees them: the price and the two ceilings a
  // plan is actually sold on.
  assert.ok(doc.includes(`$${PLAN_PRICE_CENTS.pro / 100}`), "missing the pro price");
  assert.ok(
    doc.includes(PLANS.pro.calls.toLocaleString("en-US")),
    "missing the pro call ceiling",
  );
  assert.ok(doc.includes(`${PLANS.free.brains} brain `), "missing the free brain ceiling");
});

test("the current-page slot is left exactly once, for the page to fill", async () => {
  const { machineDoc } = await load();
  const hits = machineDoc().split(CURRENT_PAGE_MARKER).length - 1;
  assert.equal(hits, 1);
});

test("SVOD: the plain-text route is retired with the public surface", async () => {
  const { GET } = await import("@/app/machine.txt/route");
  const res = GET();
  assert.equal(res.status, 410);
});
