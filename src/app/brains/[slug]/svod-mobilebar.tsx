"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/t-client";

/**
 * Mobile navigation drawer toggle (uses the existing .svod-ws-mobilebar CSS).
 * Sidebar starts open server-side for no-JS; on hydrate we collapse it so
 * Reading/editor + Save are reachable immediately. The guard (nav-guard)
 * closes the drawer only after an actual confirmed navigation and notifies
 * via `svod-nav-close` so aria-expanded stays in sync.
 */
export default function SvodMobileBar({ baseTitle }: { baseTitle: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      document.querySelector(".svod-ws")?.setAttribute("data-nav", "closed");
    } catch {
      /* noop */
    }
    const onClose = () => setOpen(false);
    window.addEventListener("svod-nav-close" as never, onClose as EventListener);
    return () =>
      window.removeEventListener("svod-nav-close" as never, onClose as EventListener);
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      document
        .querySelector(".svod-ws")
        ?.setAttribute("data-nav", next ? "open" : "closed");
    } catch {
      /* noop */
    }
  };

  return (
    <div className="svod-ws-mobilebar">
      <button
        type="button"
        className="svod-ws-btn"
        aria-expanded={open}
        aria-controls="svod-nav"
        onClick={toggle}
      >
        {open ? t("Close navigation") : t("Menu")}
      </button>
      <span className="svod-ws-mobilebase">{baseTitle}</span>
    </div>
  );
}
