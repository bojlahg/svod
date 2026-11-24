import test from "node:test";
import assert from "node:assert/strict";
import {
  svodIsDirty,
  svodSavedAfterSuccess,
  svodSaveStatus,
} from "./svod-editor-state";

// Regression: a save resolves with the SUBMITTED snapshot, so text typed
// while the request is in flight stays dirty instead of reading "Saved".
test("edits during a pending save stay dirty against the submitted version", () => {
  const saved = { title: "T", body: "one" };
  const submitted = { title: "T", body: "one + two" };
  // User keeps typing before the response arrives.
  const current = { title: "T", body: "one + two + three" };

  assert.equal(svodIsDirty(submitted, saved), true);
  const after = svodSavedAfterSuccess(submitted);
  assert.deepEqual(after, submitted);
  // Crucially not the live textarea: the extra keystroke is still unsaved.
  assert.equal(svodIsDirty(current, after), true);
  assert.equal(svodIsDirty(submitted, after), false);
});

test("untouched draft after success reads saved", () => {
  const saved = { title: "T", body: "one" };
  const submitted = { title: "T2", body: "one" };
  const after = svodSavedAfterSuccess(submitted);
  assert.equal(svodIsDirty(submitted, after), false);
  assert.equal(svodIsDirty(saved, after), true);
});

test("status prioritises pending, then error, then dirty", () => {
  assert.equal(
    svodSaveStatus({ pending: true, dirty: true, error: "x" }),
    "saving",
  );
  assert.equal(
    svodSaveStatus({ pending: false, dirty: true, error: "x" }),
    "save-error",
  );
  assert.equal(
    svodSaveStatus({ pending: false, dirty: true, error: null }),
    "unsaved",
  );
  assert.equal(
    svodSaveStatus({ pending: false, dirty: false, error: null }),
    "saved",
  );
});
