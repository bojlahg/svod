"use client";

import { useT } from "@/lib/t-client";
import { markup } from "@/lib/markup";
import { useState } from "react";
import { dismissGapSuggestion } from "@/app/brains/[slug]/exam-actions";
import { GAP_KIND_LABEL, type GapKind } from "@/lib/gap-kind";

/**
 * Gap suggestions (0043, kinds in 0055): every check the exam failed, with why
 * it failed. The why matters more than the question: only absent material is
 * fixed by adding a source, a thin note needs deepening, a ranking problem needs
 * the question's own words in the note, and a bluffed probe needs the brain to
 * cover *less*. Offering "add a source" for all four sent owners to buy pages
 * for problems pages do not fix.
 *
 * Nothing is ever added without the owner submitting the form.
 */
export default function GapSuggestions({
  slug,
  suggestions,
}: {
  slug: string;
  suggestions: { id: string; question: string; kind: GapKind }[];
}) {
  const t = useT();

  if (!suggestions.length) return null;
  return (
    <section style={{ marginTop: "2rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "1rem",
        }}
      >
        <h2 className="h2">{t("Gaps the exam keeps hitting")}</h2>
        <span className="eyebrow">
          {markup(
            suggestions.length === 1 ? t("<0/> suggestion") : t("<0/> suggestions"),
            [suggestions.length],
          )}</span>
      </div>
      <p style={{ color: "var(--ink-2)", marginTop: 0, maxWidth: "62ch" }}>
        {t("These questions were asked — by the exam or by real agents — and the brain got them wrong. Each says which kind of gap it is, because the fix differs: only the missing ones want a new source. Dismiss the ones not worth filling.")}</p>
      <div className="panel" style={{ padding: 0 }}>
        {suggestions.map((s) => (
          <GapRow key={s.id} slug={slug} suggestion={s} />
        ))}
      </div>
    </section>
  );
}

function GapRow({
  slug,
  suggestion,
}: {
  slug: string;
  suggestion: { id: string; question: string; kind: GapKind };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--rule)" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "baseline" }}>
        <span style={{ flex: 1, fontSize: ".9375rem" }}>
          {suggestion.question}
          <span
            className="mono"
            style={{
              display: "block",
              fontSize: ".75rem",
              color: "var(--ink-3)",
              marginTop: ".25rem",
            }}
          >
            {suggestion.kind}: {GAP_KIND_LABEL[suggestion.kind]}
          </span>
        </span>
        <span style={{ display: "flex", gap: "1rem", flexShrink: 0 }}>
          {suggestion.kind === "missing" && (
            <button className="mono" style={linkButton} onClick={() => setOpen((o) => !o)}>
              {open ? t("close") : t("add a source →")}
            </button>
          )}
          <form action={dismissGapSuggestion}>
            <input type="hidden" name="id" value={suggestion.id} />
            <input type="hidden" name="slug" value={slug} />
            <button className="mono" style={linkButton}>
              {t("dismiss")}
            </button>
          </form>
        </span>
      </div>

      {open && (
        <p className="mono" style={{ fontSize: ".8125rem", margin: ".5rem 0 0", color: "var(--ink-3)" }}>
          {t("Retired: add a Markdown note instead.")}
        </p>
      )}
    </div>
  );
}

const linkButton: React.CSSProperties = {
  background: "none",
  border: 0,
  padding: 0,
  color: "var(--ink-2)",
  fontSize: ".6875rem",
  cursor: "pointer",
  textDecoration: "underline",
};
