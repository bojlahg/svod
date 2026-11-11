"use client";

import { useT } from "@/lib/t-client";
import type { McpToken, McpTokenScope } from "@/db/types";
import { updateTokenScopes } from "./actions";
import { useActionState } from "react";

export default function TokenScopesForm({
  token,
  bases,
  scopes,
}: {
  token: McpToken;
  bases: { id: string; title: string; slug: string; project_id: string | null; allowed: ("read" | "propose" | "write")[] }[];
  scopes: McpTokenScope[];
}) {
  const t = useT();
  const [state, action, pending] = useActionState(updateTokenScopes, null);
  const current = new Map(scopes.map((s) => [s.brain_id, s.capability]));

  return (
    <form
      action={action}
      style={{ border: "1px solid var(--rule)", padding: ".7rem .85rem", display: "grid", gap: ".5rem" }}
    >
      <input type="hidden" name="id" value={token.id} />
      <div style={{ display: "flex", gap: ".6rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <strong className="mono" style={{ fontSize: ".8125rem" }}>
          {token.prefix}… {token.name ? `· ${token.name}` : ""}
        </strong>
        <label style={{ display: "flex", gap: ".4rem", alignItems: "center", fontSize: ".75rem" }}>
          <input
            type="checkbox"
            name="can_create_project"
            defaultChecked={Boolean((token as { can_create_project?: boolean }).can_create_project)}
          />
          {t("may create projects")}
        </label>
        <span className="mono" style={{ fontSize: ".6875rem", color: "var(--ink-2)" }}>
          {scopes.length ? `${scopes.length} ${t("base(s)")}` : t("no bases — denied everywhere")}
        </span>
      </div>
      {bases.length > 0 && (
        <div style={{ display: "grid", gap: ".3rem" }}>
          {bases.map((b) => {
            const cur = current.get(b.id) ?? "";
            return (
              <div key={b.id} style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap", fontSize: ".75rem" }}>
                <span style={{ minWidth: 160 }}>{b.title}</span>
                <label className="mono">
                  <input type="radio" name={`scope:${b.id}`} value="" defaultChecked={cur === ""} /> {t("none")}
                </label>
                {b.allowed.includes("read") && (
                  <label className="mono">
                    <input type="radio" name={`scope:${b.id}`} value="read" defaultChecked={cur === "read"} /> {t("read")}
                  </label>
                )}
                {b.allowed.includes("propose") && (
                  <label className="mono">
                    <input type="radio" name={`scope:${b.id}`} value="propose" defaultChecked={cur === "propose"} /> {t("read+propose")}
                  </label>
                )}
                {b.allowed.includes("write") && (
                  <label className="mono">
                    <input type="radio" name={`scope:${b.id}`} value="write" defaultChecked={cur === "write"} /> {t("read+direct-write")}
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div>
        <button className="btn btn-ghost" style={{ fontSize: ".75rem", padding: ".35rem .7rem" }} type="submit" disabled={pending}>
          {pending ? t("Saving…") : t("Save scopes")}
        </button>
        {state && "ok" in state && (
          <span className="mono" style={{ fontSize: ".6875rem", marginLeft: ".6rem" }}>
            {t("Saved — applies on the next call.")}
          </span>
        )}
        {state && "error" in state && (
          <span role="alert" className="mono" style={{ fontSize: ".6875rem", marginLeft: ".6rem", color: "var(--color-riso-red)" }}>
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
