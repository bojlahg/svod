import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedPath } from "./route-gate";

test("retained private surfaces pass the perimeter", () => {
  for (const p of [
    "/",
    "/sign-in",
    "/brains",
    "/brains/new",
    "/brains/some-id",
    "/brains/some-id/notes",
    "/brains/some-id/board",
    "/brains/some-id/share",
    "/b/owner/base",
    "/b/owner/base/notes",
    "/b/owner/base/notes/cat",
    "/b/owner/base/badge",
    "/b/owner/base/opengraph-image",
    "/admin",
    "/admin/users",
    "/settings",
    "/settings/tokens",
    "/connect",
    "/api/auth/sign-in/email",
    "/api/auth/get-session",
    "/api/ready",
    "/api/health",
    "/api/brains/some-id/export",
    "/api/storage/some/key",
    "/mcp",
    "/closed",
    "/favicon.ico",
    "/robots.txt",
    "/brand/mascot.webp",
    "/achievements/kind.webp",
  ]) {
    assert.equal(isAllowedPath(p), true, p);
  }
});

test("retired public and legacy surfaces are denied regardless of old flags", () => {
  for (const p of [
    "/learn",
    "/learn/h/s",
    "/health",
    "/styles",
    "/styles/new",
    "/gallery",
    "/gallery/h/s",
    "/packs",
    "/packs/x",
    "/pricing",
    "/explore",
    "/collective",
    "/api/collective",
    "/api/packs/x/export",
    "/api/payments/nowpayments",
    "/api/push",
    "/api/github/push",
    "/api/generations/x/image",
    "/api/client-error",
    "/gift/abc",
    "/welcome",
    "/mind",
    "/chat",
    "/settings/balance",
    "/settings/purchases",
    "/settings/usage",
    "/learn",
    "/make",
    "/guide",
    "/vs",
    "/b/owner",
    "/llms.txt",
    "/sitemap.xml",
  ]) {
    assert.equal(isAllowedPath(p), false, p);
  }
});
