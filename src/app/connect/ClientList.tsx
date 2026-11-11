"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { renderSnippet, type Client } from "@/lib/clients";
import { mintToken } from "./token-action";
import { useT } from "@/lib/t-client";
import { markup } from "@/lib/markup";
import { msg } from "@/lib/msg";

const FAMILY_LABEL: Record<Client["family"], string> = {
  cli: msg("Terminal"),
  editor: msg("Editor"),
  desktop: msg("Desktop"),
};

export default function ClientList({
  clients,
  url,
  signedIn,
}: {
  clients: Client[];
  url: string;
  signedIn: boolean;
}) {
  const [active, setActive] = useState(clients[0].id);
  const t = useT();
  const [copied, setCopied] = useState(false);
  // Filled in only when the reader asks for it, and only in their own browser.
  // Signed out, the page is public and the placeholder is the whole point.
  // The origin always comes from this browser's address bar — never a baked
  // build-time URL — so a token minted here connects back to this instance.
  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [minting, startMint] = useTransition();
  // The origin comes from this browser's address bar on first render —
  // never a baked build-time URL — so a command copied here connects back to
  // this instance.
  const [origin] = useState(
    () =>
      (typeof window !== "undefined" && `${window.location.origin}/mcp`) || url,
  );

  const client = clients.find((c) => c.id === active) ?? clients[0];
  const snippet = renderSnippet(client, origin, token ?? "YOUR_TOKEN");

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function makeToken() {
    setTokenError(null);
    startMint(async () => {
      const res = await mintToken();
      if ("error" in res) setTokenError(res.error);
      else setToken(res.token);
    });
  }

  const families = ["cli", "editor", "desktop"] as const;

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <div style={{ display: "grid", gap: "1.25rem" }}>
        {families.map((family) => {
          const inFamily = clients.filter((c) => c.family === family);
          if (!inFamily.length) return null;
          return (
            <div key={family}>
              <p className="eyebrow" style={{ marginBottom: ".5rem" }}>
                {t(FAMILY_LABEL[family])}
              </p>
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                {inFamily.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setActive(c.id);
                      setCopied(false);
                    }}
                    className="tag"
                    style={{
                      cursor: "pointer",
                      padding: ".45rem .7rem",
                      background: c.id === active ? "var(--ink)" : "transparent",
                      color: c.id === active ? "var(--paper-2)" : "var(--ink)",
                      borderColor: "var(--ink)",
                      fontSize: ".8125rem",
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "1.5rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: "1rem",
            flexWrap: "wrap",
            marginBottom: ".6rem",
          }}
        >
          <span className="mono" style={{ fontSize: ".8125rem", color: "var(--ink-2)" }}>
            {client.path ?? markup(t("<0/> · run this"), [client.name])}
          </span>
          <a
            className="navlink"
            href={client.docs}
            target="_blank"
            rel="noreferrer noopener"
            style={{ fontSize: ".75rem" }}
          >
            {markup(t("<0/> docs ↗"), [client.name])}
          </a>
        </div>

        <section className="term">
          <div className="term-bar">
            <span className="term-dot" />
            <span className="term-dot" />
            <span className="term-dot" />
            <span style={{ marginLeft: ".5rem" }}>
              {client.name} · {client.vendor}
            </span>
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              font: "inherit",
            }}
          >
            {snippet}
          </pre>

          <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap", marginTop: "1rem" }}>
            <button
              className="btn"
              onClick={copy}
              style={{
                background: copied ? "var(--color-riso-green)" : "var(--color-riso-yellow)",
                color: "var(--ink)",
                borderColor: copied ? "var(--color-riso-green)" : "var(--color-riso-yellow)",
              }}
            >
              {copied ? t("Copied") : token ? t("Copy — ready to run") : t("Copy")}
            </button>

            {signedIn && !token && (
              <button
                className="btn"
                onClick={makeToken}
                disabled={minting}
                style={{
                  background: "transparent",
                  color: "var(--paper)",
                  borderColor: "var(--paper)",
                }}
              >
                {minting ? t("Making…") : t("Make a token and fill it in")}
              </button>
            )}
          </div>

          {tokenError && (
            <div className="c" style={{ marginTop: ".9rem", color: "#f15060" }}>
              {tokenError}
            </div>
          )}

          <div className="c" style={{ marginTop: ".9rem" }}>
            {token ? (
              <>
                {markup(
                  t(
                    "token filled in — this is the only time it is shown. It is also on <0>your tokens page</0> as <1/>…, where you can revoke it.",
                  ),
                  [
                    <Link href="/settings/tokens" style={{ textDecoration: "underline" }} key="s0" />,
                    token.slice(0, 12),
                  ],
                )}
              </>
            ) : signedIn ? (
              <>
                {markup(
                  t("replace YOUR_TOKEN, or press the button and we will — <0>all your tokens</0>"),
                  [<Link href="/settings/tokens" style={{ textDecoration: "underline" }} key="s0" />],
                )}
              </>
            ) : (
              <>
                {markup(t("replace YOUR_TOKEN — <0>sign in to make one</0>"), [
                  <Link href="/sign-in" style={{ textDecoration: "underline" }} key="s0" />,
                ])}
              </>
            )}
          </div>
        </section>

        {client.note && (
          <p
            style={{
              marginTop: ".85rem",
              color: "var(--ink-2)",
              fontSize: ".9375rem",
              maxWidth: "62ch",
            }}
          >
            {client.note}
          </p>
        )}
      </div>
    </section>
  );
}
