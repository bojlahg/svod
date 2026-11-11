"use client";

import { useT } from "@/lib/t-client";
import { markup } from "@/lib/markup";
import Link from "next/link";
import { useState, useTransition } from "react";
import { createTokenInline } from "@/app/brains/[slug]/token-action";

/**
 * The 60-second path: copy one line, paste it in a terminal.
 *
 * The token is minted right here rather than on a settings page — anything
 * that sends a user away mid-flow is where they stop. Tokens are stored
 * hashed, so a returning user gets the command with a placeholder and the
 * option to mint a fresh one.
 */
export default function ConnectBox({
  slug,
  hasToken,
}: {
  slug: string;
  hasToken: boolean;
}) {
  const t = useT();

  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  // The origin comes from this browser's address bar on first render —
  // never a baked build-time URL — so the copied command reaches this
  // instance. The initializer runs only on the client; the server keeps the
  // configured fallback for the first paint.
  const [origin] = useState(
    () =>
      (typeof window !== "undefined" && window.location.origin) ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3300",
  );

  const secret = token ?? "YOUR_TOKEN";
  const command = `claude mcp add --transport http mozg ${origin}/mcp --header "Authorization: Bearer ${secret}"`;

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const yellow = {
    background: copied ? "var(--color-riso-green)" : "var(--color-riso-yellow)",
    color: "var(--ink)",
    borderColor: copied ? "var(--color-riso-green)" : "var(--color-riso-yellow)",
  };

  return (
    <section className="term">
      <div className="term-bar">
        <span className="term-dot" />
        <span className="term-dot" />
        <span className="term-dot" />
        <span style={{ marginLeft: ".5rem" }}>{t("use this brain")}</span>
      </div>

      <div style={{ marginBottom: ".9rem", wordBreak: "break-all" }}>
        <span className="c">$</span> {command}
      </div>

      {token ? (
        <>
          <button className="btn" onClick={copy} style={yellow}>
            {copied ? t("Copied") : t("Copy command")}
          </button>
          <div className="c" style={{ marginTop: ".75rem" }}>
            {t("copy it now — the token is stored hashed and cannot be shown again")}</div>
        </>
      ) : hasToken ? (
        <>
          <button className="btn" onClick={copy} style={yellow}>
            {copied ? t("Copied") : t("Copy command")}
          </button>
          <div className="c" style={{ marginTop: ".75rem" }}>
            {t("paste your token over YOUR_TOKEN, or")}{" "}
            <button
              onClick={() => start(async () => setToken((await createTokenInline()).token))}
              disabled={pending}
              style={{
                background: "none",
                border: 0,
                padding: 0,
                color: "var(--color-riso-yellow)",
                font: "inherit",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              {pending ? t("making one…") : t("make a new one")}
            </button>
          </div>
        </>
      ) : (
        <button
          className="btn"
          style={yellow}
          disabled={pending}
          onClick={() => start(async () => setToken((await createTokenInline()).token))}
        >
          {pending ? t("Creating…") : t("Create token and show command")}
        </button>
      )}

      <div style={{ marginTop: "1.1rem" }} className="c">
        {t("then, in your editor:")}</div>
      <div>
        {markup(t("<0>&gt;</0> use mozg:<1/> — …"), [
        <span className="u" key="s0" />,
        slug,
      ])}</div>

      {/* The command above is Claude Code only; everyone else lands on /connect. */}
      <div className="c" style={{ marginTop: "1.1rem" }}>
        {markup(t("not Claude Code? <0>setup for Codex, Cursor, Kimi and the rest →</0>"), [
        <Link href="/connect" style={{ color: "var(--color-riso-yellow)", textDecoration: "underline" }} key="s0" />,
      ])}</div>
    </section>
  );
}
