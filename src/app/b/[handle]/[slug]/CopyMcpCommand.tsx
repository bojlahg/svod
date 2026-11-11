"use client";

import { useT } from "@/lib/t-client";
import { useState } from "react";
import { mintTokenForCopy } from "./token-action";

/**
 * One click puts a WORKING connect command on the clipboard. Signed in, the
 * first press mints a real token (kept in state, so pressing twice does not
 * mint twice) and copies the command with it filled in — copy, paste, done.
 * The origin comes from this browser's address bar, never a baked URL.
 */
export default function CopyMcpCommand({ signedIn }: { signedIn: boolean }) {
  const t = useT();

  const [copied, setCopied] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The origin comes from this browser's address bar on first render — never
  // a baked URL — so the copied command reaches this instance.
  const [origin] = useState(
    () =>
      (typeof window !== "undefined" && window.location.origin) ||
      "http://localhost:3300",
  );

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      let token = minted;
      if (!token && signedIn) {
        const r = await mintTokenForCopy();
        if ("error" in r) {
          setError(r.error);
          return;
        }
        token = r.token;
        setMinted(token);
      }
      await navigator.clipboard.writeText(
        `claude mcp add --transport http mozg ${origin}/mcp --header "Authorization: Bearer ${token ?? "YOUR_TOKEN"}"`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", gap: ".75rem", alignItems: "center", flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={copy}
        disabled={busy}
        className="mono"
        style={{
          marginTop: "1rem",
          padding: ".45rem .9rem",
          background: copied ? "var(--color-riso-green)" : "transparent",
          color: copied ? "var(--ink)" : "#e6e8ea",
          border: "1.5px solid #6d747e",
          cursor: "pointer",
          fontSize: ".8125rem",
        }}
      >
        {busy
          ? "…"
          : copied
            ? t("copied ✓ — now paste it in your terminal")
            : signedIn
              ? t("copy with my token")
              : t("copy command")}
      </button>
      {error && (
        <span className="mono" style={{ marginTop: "1rem", fontSize: ".75rem", color: "var(--color-riso-red)" }}>
          {error}
        </span>
      )}
    </span>
  );
}
