"use client";

import { useT } from "@/lib/t-client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { createBrain } from "../actions";
import { TOPICS } from "@/lib/topics";

const STYLE_EXAMPLE =
  "Reproduce my illustration style exactly: the palette with its hex values, how light and shading behave, line character, composition habits, and the hard nevers.";

const EXAMPLES = [
  "Match our design system exactly: colour, type scale, spacing, component rules, empty and error states.",
  "Answer questions about the Stripe webhook flow we actually run — our retries and idempotency, not the docs version.",
  "Follow our Postgres conventions: naming, migrations, indexing, and the things we never do.",
];

export default function NewBrainForm({
  parents,
}: {
  parents: { id: string; title: string }[];
}) {
  const t = useT();

  const [state, action, pending] = useActionState(createBrain, null);
  const [kind, setKind] = useState<"knowledge" | "style">("knowledge");
  const style = kind === "style";

  return (
    <>
      <form action={action} className="panel" style={{ display: "grid", gap: "1.5rem" }}>
        {/* First, because it changes what every field below means. A style is
            not a knowledge base with an art topic: its uploads are read by an
            art director rather than a documentation reader, and its exam asks
            whether the style can be reproduced rather than what it can
            answer. Asking this at the end would be asking after the answer
            stopped mattering. */}
        <Field label={t("What are you building?")} hint={t("It decides how mozg reads what you feed it.")}>
          <div style={{ display: "grid", gap: ".5rem" }}>
            {[
              {
                value: "knowledge" as const,
                label: t("A knowledge brain"),
                detail: t("Conventions, APIs, decisions, documentation — anything with facts in it."),
              },
              {
                value: "style" as const,
                label: t("A style brain"),
                detail:
                  t("A way of working: palette, light, line, the hard nevers. Drop your own work in and mozg writes the rules it measures. Sells in the gallery."),
              },
            ].map((k) => (
              <label key={k.value} style={{ display: "flex", gap: ".6rem", alignItems: "flex-start" }}>
                <input
                  type="radio"
                  name="kind"
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => setKind(k.value)}
                  style={{ marginTop: ".3rem" }}
                />
                <span>
                  <strong>{k.label}</strong>
                  <span style={{ display: "block", color: "var(--ink-2)", fontSize: ".9375rem" }}>
                    {k.detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field
          label={t("Name")}
          hint={t("What you'll call it in your editor, e.g. mozg:design")}
        >
          <input
            name="title"
            required
            maxLength={80}
            autoFocus
            placeholder={style ? "My illustration style" : "Design system"}
            style={inputStyle}
          />
        </Field>

        <Field
          label={t("Field")}
          hint={t("How people find it in the catalogue if you ever publish it.")}
        >
          <select name="topic" key={kind} defaultValue={style ? "art" : "web"} style={inputStyle}>
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
            key={kind}
            placeholder={style ? STYLE_EXAMPLE : EXAMPLES[0]}
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
              <li key={e}>{e}</li>
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
  border: "1.5px solid var(--ink)",
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
