import "./test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkspaceSameOrigin } from "./svod-workspace-origin";

const ENV_127 = ["http://127.0.0.1:39748", "http://127.0.0.1:39748"];

test("legitimate 127.0.0.1 origin passes while internal URL is localhost", () => {
  assert.equal(
    isWorkspaceSameOrigin({
      origin: "http://127.0.0.1:39748",
      referer: null,
      reqUrl: "http://localhost:39748/api/brains/x/workspace",
      host: "127.0.0.1:39748",
      configuredOrigins: ENV_127,
    }),
    true,
  );
});

test("foreign origin is still 403 even with internal URL", () => {
  assert.equal(
    isWorkspaceSameOrigin({
      origin: "http://evil.example.com",
      referer: null,
      reqUrl: "http://localhost:39748/api/brains/x/workspace",
      host: "127.0.0.1:39748",
      configuredOrigins: ENV_127,
    }),
    false,
  );
});

test("missing Origin/Referer keeps SameSite behavior (allow)", () => {
  assert.equal(
    isWorkspaceSameOrigin({
      origin: null,
      referer: null,
      reqUrl: "http://localhost:39748/api/brains/x/workspace",
      host: "127.0.0.1:39748",
      configuredOrigins: ENV_127,
    }),
    true,
  );
});

test("reverse-proxy public https origin passes via configured URL", () => {
  assert.equal(
    isWorkspaceSameOrigin({
      origin: "https://public.example.com",
      referer: null,
      reqUrl: "http://localhost:3300/api/brains/x/workspace",
      host: "public.example.com",
      configuredOrigins: ["https://public.example.com", "https://public.example.com"],
    }),
    true,
  );
});
