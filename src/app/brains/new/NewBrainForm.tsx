"use client";

import { useT } from "@/lib/t-client";
import { useActionState } from "react";
import Link from "next/link";
import { createBrain } from "../actions";

export default function NewBrainForm({
  parents,
}: {
  parents: { id: string; title: string }[];
}) {
  const t = useT();

  const [state, action, pending] = useActionState(createBrain, null);

  return (
    <>
      <form action={action} className="panel" style={{ display: "grid", gap: "1.5rem" }}>
        <Field
          label={t("Name")}
          hint={t("The name you and your agents will see.")}
        >
          <input
            name="title"
            required
            maxLength={80}
            autoFocus
            placeholder={t("Design system")}
            style={inputStyle}
          />
        </Field>

        {parents.length > 0 && (
          <Field
            label={t("Group it under")}
            hint={t("For a big subject split into parts. Searching the parent searches every child.")}
          >
            <select name="parent" defaultValue="" style={inputStyle}>
              <option value="">{t("on its own")}</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label={t("Description (optional)")}
          hint={t("A short note about what this base holds.")}
        >
          <textarea
            name="goal"
            rows={4}
            maxLength={4000}
            placeholder={t("What this base is for.")}
            style={inputStyle}
          />
        </Field>

        {state?.error && (
          <p
            className="ui-text"
            style={{ color: "var(--color-riso-red)", fontSize: ".8125rem", margin: 0 }}
          >
            {state.error}
          </p>
        )}

        <div style={{ display: "flex", gap: ".75rem" }}>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? t("Creating…") : t("Create base")}
          </button>
          <Link className="btn btn-ghost" href="/brains">
            {t("Cancel")}</Link>
        </div>
      </form>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: ".7rem .85rem",
  border: "1px solid var(--rule)",
  background: "var(--paper)",
  color: "var(--ink)",
  font: "inherit",
  fontSize: "1rem",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: ".4rem" }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span className="ui-text" style={{ fontSize: ".875rem", color: "var(--ink-2)" }}>
        {hint}
      </span>
      {children}
    </label>
  );
}
