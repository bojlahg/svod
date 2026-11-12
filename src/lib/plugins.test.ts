import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLUGINS, MARKETPLACE, MARKETPLACE_SOURCE, installCommand } from "./plugins";

/**
 * The list in plugins.ts is what the product tells people to install. The
 * marketplace file is what actually exists. If they drift, mozg prints a
 * command that does nothing — which is the failure this whole field was
 * rebuilt to make impossible, so it is worth a check rather than a habit.
 */
test("every plugin mozg offers is one the marketplace really ships", () => {
  const file = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
  const shipped = new Set<string>(file.plugins.map((p: { name: string }) => p.name));

  for (const name of Object.keys(PLUGINS)) {
    assert.ok(shipped.has(name), `plugins.ts offers "${name}", the marketplace does not ship it`);
  }
  // The marketplace name is half of `<plugin>@<marketplace>`; a rename there
  // silently breaks every command this file generates.
  assert.equal(file.name, MARKETPLACE);
});

test("the command is only ever built for something we publish", () => {
  assert.equal(installCommand("svod"), "/plugin install svod@svod");
  assert.equal(installCommand("mozg"), "/plugin install svod@svod");
  assert.equal(installCommand("svod-spine"), "/plugin install svod-spine@svod");
  assert.equal(installCommand("mozg-spine"), "/plugin install svod-spine@svod");
  // The shape of the bug this replaced: a plausible name for a thing we do not
  // ship has to produce nothing, not a command. `spine-mcp` is the package name
  // of the server itself — real, and still not a mozg plugin.
  assert.equal(installCommand("spine-mcp"), null);
  assert.equal(installCommand("mozg-pixi"), null);
  assert.equal(installCommand(""), null);
  // Never let a prototype-chain name look published.
  assert.equal(installCommand("toString"), null);
  assert.equal(installCommand("constructor"), null);
});

test("the marketplace source is the one the docs tell people to add", () => {
  const connect = readFileSync("src/app/connect/page.tsx", "utf8");
  assert.ok(
    connect.includes(MARKETPLACE_SOURCE),
    `/connect tells people to add a different marketplace than ${MARKETPLACE_SOURCE}`,
  );
});
