"use client";

import { useT } from "@/lib/t-client";
import { useActionState, useState } from "react";
import { saveGoal } from "@/app/brains/[slug]/exam-actions";

/**
 * The goal is the most load-bearing field in the product — it becomes the exam.
 * Editing it in place, rather than on a settings page, keeps that connection
 * visible: change the goal, the score resets and the brain re-sits.
 */
export default function GoalEditor({
  slug,
  goal,
}: {
  slug: string;
  goal: string | null;
}) {
  const t = useT();

  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(saveGoal, null);

  if (!editing) {
    return (
      <div>
        <p style={{ color: "var(--ink-2)", margin: ".6rem 0 0", maxWidth: "60ch" }}>
          {goal ?? t("No goal set — the brain can store notes but cannot be examined.")}
        </p>
        <button
          onClick={() => setEditing(true)}
          className="navlink"
          style={{
            background: "none",
            border: 0,
            padding: 0,
            marginTop: ".4rem",
            cursor: "pointer",
          }}
        >
          {goal ? t("edit goal") : t("set a goal")} →
        </button>
        {state?.error && (
          <p
            className="mono"
            style={{ fontSize: ".75rem", color: "var(--color-riso-red)", marginTop: ".4rem" }}
          >
            {state.error}</p>
        )}
      </div>
    );
  }

  return (
    <form
      action={action}
      style={{ marginTop: ".6rem", maxWidth: "60ch", display: "grid", gap: ".6rem" }}
    >
      <input type="hidden" name="slug" value={slug} />
      <textarea
        name="goal"
        rows={4}
        defaultValue={goal ?? ""}
        autoFocus
        placeholder={t("What should this brain be able to do? Be concrete — vague goals produce vague checks.")}
        style={{
          width: "100%",
          padding: ".7rem .85rem",
          border: "1.5px solid var(--ink)",
          background: "var(--paper-2)",
          font: "inherit",
          fontSize: ".9375rem",
        }}
      />
      <p className="mono" style={{ fontSize: ".75rem", color: "var(--ink-2)", margin: 0 }}>
        {t("Changing this clears the exam and starts a new one.")}</p>
      <div style={{ display: "flex", gap: ".5rem" }}>
        <button className="btn" disabled={pending} style={{ padding: ".45rem .9rem" }}>
          {pending ? t("Saving…") : t("Save goal")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: ".45rem .9rem" }}
          onClick={() => setEditing(false)}
        >
          {t("Cancel")}</button>
      </div>
      {state?.error && (
        <p className="mono" style={{ color: "var(--color-riso-red)", fontSize: ".8125rem" }}>
          {state.error}
        </p>
      )}
    </form>
  );
}
