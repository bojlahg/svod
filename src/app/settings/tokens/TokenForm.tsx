"use client";

import { useT } from "@/lib/t-client";
import { useActionState, useState } from "react";
import { createToken } from "./actions";

export interface ScopeBase {
  id: string;
  title: string;
  slug: string;
  project_id: string | null;
  allowed: ("read" | "propose" | "write")[];
}

export default function TokenForm({ bases }: { bases: ScopeBase[] }) {
  const t = useT();

  const [state, action, pending] = useActionState(createToken, null);
  const [copied, setCopied] = useState(false);

  const [origin] = useState(
    () =>
      (typeof window !== "undefined" && window.location.origin) ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3300",
  );

  if (state && "token" in state) {
    const command = `claude mcp add --transport http svod ${origin}/mcp --header "Authorization: Bearer ${state.token}"`;
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
            color: "#0b0d10",
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
    <form action={action} style={{ display: "grid", gap: ".75rem", marginTop: "1.5rem" }}>
      <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
        <input
          name="name"
          placeholder={t("What machine is this for? e.g. macbook")}
          maxLength={60}
          style={{
            flex: 1,
            minWidth: 240,
            padding: ".7rem .85rem",
            border: "1px solid var(--rule)",
            color: "var(--ink)",
            background: "var(--paper-2)",
            font: "inherit",
          }}
        />
        <button className="btn" disabled={pending}>
          {pending ? t("Creating…") : t("New token")}
        </button>
      </div>
      <label style={{ display: "flex", gap: ".5rem", alignItems: "center", fontSize: ".8125rem" }}>
        <input type="checkbox" name="can_create_project" />
        {t("May create project bases (stable project_id, separate grant, default off)")}
      </label>
      {bases.length > 0 ? (
        <fieldset style={{ border: "1px solid var(--rule)", padding: ".7rem .85rem" }}>
          <legend className="mono" style={{ fontSize: ".75rem" }}>
            {t("Bases this token may open (default deny — pick each)")}
          </legend>
          <div style={{ display: "grid", gap: ".4rem" }}>
            {bases.map((b) => (
              <div key={b.id} style={{ display: "flex", gap: ".6rem", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ minWidth: 180, fontSize: ".8125rem" }}>
                  {b.title} {b.project_id ? `· ${t("project")}` : `· ${t("general")}`}
                </span>
                <label className="mono" style={{ fontSize: ".75rem" }}>
                  <input type="radio" name={`scope:${b.id}`} value="" defaultChecked /> {t("none")}
                </label>
                {b.allowed.includes("read") && (
                  <label className="mono" style={{ fontSize: ".75rem" }}>
                    <input type="radio" name={`scope:${b.id}`} value="read" /> {t("read")}
                  </label>
                )}
                {b.allowed.includes("propose") && (
                  <label className="mono" style={{ fontSize: ".75rem" }}>
                    <input type="radio" name={`scope:${b.id}`} value="propose" /> {t("read+propose")}
                  </label>
                )}
                {b.allowed.includes("write") && (
                  <label className="mono" style={{ fontSize: ".75rem" }}>
                    <input type="radio" name={`scope:${b.id}`} value="write" /> {t("read+direct-write")}
                  </label>
                )}
              </div>
            ))}
          </div>
          <p className="mono" style={{ fontSize: ".6875rem", color: "var(--ink-2)", margin: ".6rem 0 0" }}>
            {t("Read opens list/brief/search/read. Propose adds pending proposals. Direct-write is project bases only, no review.")}
          </p>
        </fieldset>
      ) : (
        <p className="mono" style={{ fontSize: ".75rem" }}>
          {t("No bases available to grant yet — create one first.")}
        </p>
      )}
      {state && "error" in state && (
        <p role="alert" style={{ width: "100%", margin: 0, color: "var(--ink-2)" }}>
          {state.error}
        </p>
      )}
    </form>
  );
}
