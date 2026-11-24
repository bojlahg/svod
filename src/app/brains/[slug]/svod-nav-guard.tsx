"use client";

import { useEffect } from "react";
import { useT } from "@/lib/t-client";
import {
  armSvodBypassUnload,
  consumeSvodBypassUnload,
  hasSvodUnsavedDraft,
} from "./svod-draft-guard";

/**
 * Tab/window-close guard + in-workspace link guard.
 *
 * beforeunload covers reloads, tab closes and URL-bar navigation. Same-origin
 * anchor navigations (including relative links, /settings, wordmark) are
 * confirmed in capture phase so a dirty draft survives an accidental
 * note/base switch. Same-document hashes, downloads, new tabs and modifier
 * clicks pass through. Forms use their own submit guard (see svod-forms) —
 * this component only handles anchors + Back/Forward.
 *
 * Duplicate dialogs are avoided: after an explicit link confirmation we arm a
 * one-time beforeunload bypass; tree/base/editor hard navigations clear the
 * flag synchronously right before reload/assign (failure keeps the draft).
 * Back/Forward uses a same-URL history sentinel so the first Back while dirty
 * stays on the page (draft preserved, no framework desync); confirming goes
 * back once more to actually leave.
 */
export default function SvodNavGuard() {
  const t = useT();

  useEffect(() => {
    const closeMobileNav = () => {
      try {
        document.querySelector(".svod-ws")?.setAttribute("data-nav", "closed");
        window.dispatchEvent(new CustomEvent("svod-nav-close"));
      } catch {
        /* noop */
      }
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (consumeSvodBypassUnload()) return;
      if (!hasSvodUnsavedDraft()) return;
      e.preventDefault();
    };

    const isSameDocumentHash = (url: URL) => {
      try {
        const cur = new URL(window.location.href);
        return (
          url.origin === cur.origin &&
          url.pathname === cur.pathname &&
          url.search === cur.search
        );
      } catch {
        return false;
      }
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const el = (e.target as HTMLElement | null)?.closest?.("a[href]");
      if (!el) return;
      const anchor = el as HTMLAnchorElement;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const rel = (anchor.getAttribute("rel") ?? "").toLowerCase();
      if (rel.split(/\s+/).includes("external")) return;
      const rawHref = anchor.getAttribute("href") ?? "";
      if (!rawHref || rawHref.startsWith("#")) return;
      if (/^(mailto|tel|javascript|data|blob):/i.test(rawHref.trim())) return;
      let url: URL;
      try {
        url = new URL(rawHref, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same-document hash only: skip (no draft loss).
      if (isSameDocumentHash(url) && url.hash) return;
      // Same URL incl. hash equality: nothing to guard.
      try {
        if (url.href === window.location.href) return;
      } catch {
        /* noop */
      }
      if (!hasSvodUnsavedDraft()) {
        closeMobileNav();
        return;
      }
      const ok = window.confirm(t("You have unsaved changes. Leave without saving?"));
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      } else {
        // User explicitly discarded: avoid a second beforeunload on hard nav.
        armSvodBypassUnload();
        closeMobileNav();
      }
    };

    // Back/Forward sentinel: same-URL entry pushed while dirty so the first
    // Back stays mounted (draft intact). Confirm-then-back leaves for real.
    const armedRef = { current: false };
    const editorUrlRef = { current: "" };
    const pushSentinel = () => {
      if (armedRef.current) return;
      try {
        editorUrlRef.current = window.location.href;
        window.history.pushState({ __svodGuard: 1 }, "", window.location.href);
        armedRef.current = true;
      } catch {
        /* noop */
      }
    };
    const onDraftChange = (ev: Event) => {
      const dirty = (ev as CustomEvent<boolean>).detail === true;
      if (dirty) {
        pushSentinel();
      } else if (armedRef.current) {
        armedRef.current = false;
        try {
          // Collapse the same-URL sentinel so the next Back leaves in one press.
          const st = window.history.state as { __svodGuard?: unknown } | null;
          if (st && (st as { __svodGuard?: unknown }).__svodGuard) {
            window.history.back();
          }
        } catch {
          /* noop */
        }
      }
    };

    const onPopState = () => {
      if (!hasSvodUnsavedDraft() || !armedRef.current) {
        armedRef.current = false;
        return;
      }
      // Sentinel pop keeps the same URL (editor still mounted).
      let sameUrl = true;
      try {
        sameUrl = window.location.href === editorUrlRef.current;
      } catch {
        sameUrl = true;
      }
      if (!sameUrl) {
        // Missed trap (real navigation already happened): nothing safe to
        // restore without losing React draft state — disarm and allow.
        armedRef.current = false;
        return;
      }
      const ok = window.confirm(t("You have unsaved changes. Leave without saving?"));
      if (!ok) {
        // Stay: re-arm the trap (pop consumed our sentinel).
        armedRef.current = false;
        try {
          window.history.pushState({ __svodGuard: 1 }, "", window.location.href);
          editorUrlRef.current = window.location.href;
          armedRef.current = true;
        } catch {
          /* noop */
        }
      } else {
        armedRef.current = false;
        armSvodBypassUnload();
        closeMobileNav();
        try {
          // Actually leave: the popped sentinel kept us on-page, go back once more.
          window.history.back();
        } catch {
          /* noop */
        }
      }
    };

    if (hasSvodUnsavedDraft()) pushSentinel();
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("svod-draft-change" as never, onDraftChange as EventListener);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("svod-draft-change" as never, onDraftChange as EventListener);
      window.removeEventListener("popstate", onPopState);
    };
  }, [t]);

  return null;
}
