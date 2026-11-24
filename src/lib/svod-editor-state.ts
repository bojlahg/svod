/**
 * Pure draft-state helpers for the SVOD note editor.
 *
 * The editor shows one of pending / unsaved / saved (+ error) derived from
 * three snapshots: the initial server values, the last successfully saved
 * values, and the in-flight submitted values. Keeping this pure (no React)
 * makes the regression it guards — "edited during a pending save must stay
 * dirty against the submitted version, not the pre-save version" — unit
 * testable without a browser.
 */

export interface SvodEditorSnapshot {
  title: string;
  body: string;
}

export function svodSnapshotsEqual(
  a: SvodEditorSnapshot,
  b: SvodEditorSnapshot,
): boolean {
  return a.title === b.title && a.body === b.body;
}

/** Dirty when the current draft differs from the last saved snapshot. */
export function svodIsDirty(
  current: SvodEditorSnapshot,
  saved: SvodEditorSnapshot,
): boolean {
  return !svodSnapshotsEqual(current, saved);
}

/**
 * Saved snapshot after a successful save: the SUBMITTED values, not the
 * current textarea values. A keystroke that lands while the request is in
 * flight stays dirty (current !== submitted) instead of being silently
 * marked saved.
 */
export function svodSavedAfterSuccess(
  submitted: SvodEditorSnapshot,
): SvodEditorSnapshot {
  return { title: submitted.title, body: submitted.body };
}

export type SvodSaveStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "save-error";

export function svodSaveStatus(opts: {
  pending: boolean;
  dirty: boolean;
  error: string | null;
}): SvodSaveStatus {
  if (opts.pending) return "saving";
  if (opts.error) return "save-error";
  return opts.dirty ? "unsaved" : "saved";
}
