"use client";

import { useT } from "@/lib/t-client";
import { useActionState, useState } from "react";
import { createToken } from "./actions";

export default function TokenForm() {
  const t = useT();

  const [state, action, pending] = useActionState(createToken, null);
  const [copied, setCopied] = useState(false);

  // The origin comes from this browser's address bar on first render — never
  // a baked build-time URL — so the copied command reaches this instance.
  const [origin] = useState(
    () =>
      (typeof window !== "undefined" && window.location.origin) ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3300",
  );

  if (state && "token" in state) {
    const command = `claude mcp add --transport http mozg ${origin}/mcp --header "Authorization: Bearer ${state.token}"`;
    return (
      <section className="term" style={{ marginTop: "1.5rem" }}>
        <div className="term-bar">
          <span className="term-dot" />
          <span className="term-dot" />
          <span className="term-dot" />
          <span style={{ marginLeft: ".5rem" }}>{t("copy this now")}</span>
        </div>
        <div style={{ wordBreak: "break-all", marginBottom: ".9rem" }}>
          <span className="c">$</span> {command}
        </div>
        <button
          className="btn"
          style={{
            background: copied ? "var(--color-riso-green)" : "var(--color-riso-yellow)",
            color: "var(--ink)",
            borderColor: copied ? "var(--color-riso-green)" : "var(--color-riso-yellow)",
          }}
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? t("Copied") : t("Copy command")}
        </button>
        <div className="c" style={{ marginTop: "1rem" }}>
          {t("This is the only time the token is shown. Losing it means making a new one.")}</div>
      </section>
    );
  }

  return (
    <form
      action={action}
      style={{ display: "flex", gap: ".75rem", marginTop: "1.5rem", flexWrap: "wrap" }}
    >
      <input
        name="name"
        placeholder={t("What machine is this for? e.g. macbook")}
        maxLength={60}
        style={{
          flex: 1,
          minWidth: 240,
          padding: ".7rem .85rem",
          border: "1.5px solid var(--ink)",
          background: "var(--paper-2)",
          font: "inherit",
        }}
      />
      <button className="btn" disabled={pending}>
        {pending ? t("Creating…") : t("New token")}
      </button>
      {state && "error" in state && (
        <p role="alert" style={{ width: "100%", margin: 0, color: "var(--ink-2)" }}>
          {state.error}
        </p>
      )}
    </form>
  );
}
