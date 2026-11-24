"use client";

/**
 * Shared unsaved-draft flag for the workspace.
 *
 * The editor sets it; sidebar links, tree forms that hard-reload, and the
 * tab/window close path read it. A tiny window global keeps server-rendered
 * links and independent client forms in agreement without a provider.
 */

declare global {
  interface Window {
    __svodHasUnsavedDraft?: boolean;
    __svodBypassUnload?: boolean;
  }
}

export function setSvodUnsavedDraft(dirty: boolean): void {
  if (typeof window === "undefined") return;
  window.__svodHasUnsavedDraft = dirty;
  try {
    window.dispatchEvent(
      new CustomEvent<boolean>("svod-draft-change", { detail: dirty }),
    );
  } catch {
    /* non-DOM test env */
  }
}

export function hasSvodUnsavedDraft(): boolean {
  if (typeof window === "undefined") return false;
  return window.__svodHasUnsavedDraft === true;
}

/** One-time bypass for the next beforeunload after an explicit confirmation. */
export function armSvodBypassUnload(): void {
  if (typeof window === "undefined") return;
  window.__svodBypassUnload = true;
  // SPA navigations never fire beforeunload: auto-clear so a later tab-close
  // with a new dirty draft still guards.
  window.setTimeout(() => {
    try {
      if (typeof window !== "undefined") window.__svodBypassUnload = false;
    } catch {
      /* noop */
    }
  }, 1500);
}

export function consumeSvodBypassUnload(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__svodBypassUnload === true) {
    window.__svodBypassUnload = false;
    return true;
  }
  return false;
}

/** Clear the flag synchronously before a legitimate confirmed navigation. */
export function clearSvodUnsavedDraftForNavigation(): void {
  if (typeof window === "undefined") return;
  window.__svodHasUnsavedDraft = false;
}

export function confirmSvodDiscard(t: (s: string) => string): boolean {
  if (!hasSvodUnsavedDraft()) return true;
  return window.confirm(t("You have unsaved changes. Leave without saving?"));
}
