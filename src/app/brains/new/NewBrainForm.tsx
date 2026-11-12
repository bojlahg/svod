"use client";

import { useT } from "@/lib/t-client";
import { msg } from "@/lib/msg";
import { useActionState } from "react";
import Link from "next/link";
import { createBrain } from "../actions";
import { TOPICS } from "@/lib/topics";

const EXAMPLES = [
  msg("Match our design system exactly: colour, type scale, spacing, component rules, empty and error states."),
  msg("Answer questions about the Stripe webhook flow we actually run — our retries and idempotency, not the docs version."),
  msg("Follow our Postgres conventions: naming, migrations, indexing, and the things we never do."),
];

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

        <Field
          label={t("Field")}
          hint={t("A label for what this base is about.")}
        >
          <select name="topic" defaultValue="web" style={inputStyle}>
            {TOPICS.map((field) => (
              <option key={field.key} value={field.key}>
                {t(field.label)}
              </option>
            ))}
          </select>
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
          label={t("What should it be able to do? (optional)")}
          hint={t("A short note about what this base holds. Exams are not part of the Markdown workspace.")}
        >
          <textarea
            name="goal"
            rows={4}
            placeholder={t(EXAMPLES[0])}
            style={inputStyle}
          />
        </Field>

        <div>
          <p className="eyebrow" style={{ marginBottom: ".5rem" }}>
            {t("Examples")}</p>
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.1rem",
              color: "var(--ink-2)",
              fontSize: ".9375rem",
              display: "grid",
              gap: ".35rem",
            }}
          >
            {EXAMPLES.map((e) => (
              <li key={e}>{t(e)}</li>
            ))}
          </ul>
        </div>

        {state?.error && (
          <p
            className="mono"
            style={{ color: "var(--color-riso-red)", fontSize: ".8125rem", margin: 0 }}
          >
            {state.error}
          </p>
        )}

        <div style={{ display: "flex", gap: ".75rem" }}>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? t("Creating…") : t("Create brain")}
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
      <span className="mono" style={{ fontSize: ".75rem", color: "var(--ink-2)" }}>
        {hint}
      </span>
      {children}
    </label>
  );
}
