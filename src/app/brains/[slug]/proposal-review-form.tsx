"use client";

import { useT } from "@/lib/t-client";
import { useActionState, useState, type FormEvent } from "react";
import { MARKDOWN_HELP_EXAMPLES } from "@/lib/svod-markdown";
import SvodMarkdown from "@/components/SvodMarkdown";
import { approveNote, editProposalAction } from "./review-actions";

/**
 * SVOD stage 4 reviewer form: edit a pending proposal (shared Markdown
 * help/preview), pick destination brain/folder (only offered when the reviewer
 * holds review rights on both — enforced server-side too), then approve.
 * Submits the versions actually shown; conflicts remain pending with readable
 * feedback + current accepted version (no silent overwrite of unseen content).
 * Cross-base moves default to destination root with its authorized folders;
 * stale source-folder selections are reset on destination change.
 */
export default function ProposalReviewForm({
  proposalId,
  slug,
  initialTitle,
  initialBody,
  foldersByBrain,
  bases,
  currentBrainId,
  proposalRevision,
  targetRevision,
  expectedSourceBrainId,
}: {
  proposalId: string;
  slug: string;
  initialTitle: string;
  initialBody: string;
  foldersByBrain: Record<string, { id: string; label: string }[]>;
  bases: { id: string; title: string }[];
  currentBrainId: string;
  proposalRevision: number;
  targetRevision: number | null;
  expectedSourceBrainId: string;
}) {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [showPreview, setShowPreview] = useState(false);
  const [destBrain, setDestBrain] = useState(currentBrainId);
  // Cross-base default is destination root ("__root"); same-base default keeps
  // the proposal folder (""). Stale source selections reset on base change.
  const [destFolder, setDestFolder] = useState("");
  // The revision actually shown in this form. Refreshed from each successful
  // save so repeated saves keep working; the mount stays keyed by stable
  // proposal ID, so local draft and feedback survive revalidations.
  const [expectedRev, setExpectedRev] = useState(proposalRevision);
  const [editPending, setEditPending] = useState(false);
  const [editResult, setEditResult] = useState<
    | null
    | { ok: true; revision: number }
    | { error: string; current?: { title: string; body: string; revision: number } | null }
  >(null);
  const [approveState, approveAction, approvePending] = useActionState(approveNote, null);

  // The save action is awaited directly rather than through the useActionState
  // dispatcher: the awaited return settles with the response, so a finished
  // save always clears pending and shows feedback, independent of how long the
  // router transition for the revalidated route takes. Nothing is announced
  // before the response arrives.
  async function onEditSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setEditPending(true);
    try {
      const res = await editProposalAction(null, fd);
      setEditResult(res);
      if (res && "ok" in res && "revision" in res && typeof res.revision === "number") {
        setExpectedRev(res.revision);
      }
    } catch {
      setEditResult({ error: t("Could not save. Check the connection and retry.") });
    } finally {
      setEditPending(false);
    }
  }

  const conflictCurrent =
    (approveState && "current" in approveState && (approveState as { current?: { title: string; body: string; revision: number } }).current) ||
    (editResult && "current" in editResult && editResult.current) ||
    null;

  const destFolders = foldersByBrain[destBrain] ?? [];
  const crossBase = destBrain !== currentBrainId;

  return (
    <div style={{ display: "grid", gap: ".5rem", marginTop: ".4rem" }}>
      <details style={{ border: "1px solid #2a2e35", borderRadius: 6, padding: ".5rem .6rem" }}>
        <summary style={{ cursor: "pointer", fontSize: ".75rem", color: "#9aa3af" }}>
          {t("Reviewer edit (Markdown help + preview)")}
        </summary>
        <div style={{ display: "grid", gap: ".4rem", marginTop: ".5rem" }}>
          <div style={{ display: "grid", gap: ".3rem" }}>
            {MARKDOWN_HELP_EXAMPLES.map((ex) => (
              <div key={ex.title} style={{ fontSize: ".75rem" }}>
                <strong>{ex.title}</strong>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", color: "#9aa3af" }}>{ex.sample}</pre>
              </div>
            ))}
          </div>
          <label style={{ display: "grid", gap: ".25rem", fontSize: ".75rem" }}>
            {t("Title")}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ padding: ".45rem .55rem", background: "#0b0d10", border: "1px solid #2a2e35", borderRadius: 4, color: "#e6e8ea", font: "inherit" }}
            />
          </label>
          <label style={{ display: "grid", gap: ".25rem", fontSize: ".75rem" }}>
            {t("Markdown body")}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              style={{ padding: ".5rem .6rem", background: "#0b0d10", border: "1px solid #2a2e35", borderRadius: 4, color: "#e6e8ea", font: "inherit", fontFamily: "ui-monospace, Menlo, monospace", fontSize: ".8125rem" }}
            />
          </label>
          <div style={{ display: "flex", gap: ".4rem" }}>
            <button type="button" className="svod-btn-ghost" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? t("Hide preview") : t("Show preview")}
            </button>
          </div>
          {showPreview && <SvodMarkdown body={body} />}
          <form method="post" onSubmit={onEditSubmit} style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
            <input type="hidden" name="id" value={proposalId} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="title" value={title} />
            <input type="hidden" name="body" value={body} />
            <input type="hidden" name="expectedProposalRevision" value={expectedRev} />
            <input type="hidden" name="expectedTargetRevision" value={targetRevision ?? ""} />
            <button className="svod-btn-ghost" type="submit" disabled={editPending}>
              {editPending ? t("Saving…") : t("Save edit / rebase")}
            </button>
          </form>
          {editResult && "error" in editResult && (
            <p role="alert" style={{ color: "#f87171", fontSize: ".75rem", margin: 0 }}>
              {editResult.error}
            </p>
          )}
          {editResult && "ok" in editResult && (
            <p style={{ color: "#34d399", fontSize: ".75rem", margin: 0 }}>{t("Saved.")}</p>
          )}
        </div>
      </details>

      <form action={approveAction} style={{ display: "flex", gap: ".4rem", flexWrap: "wrap", alignItems: "center" }}>
        <input type="hidden" name="id" value={proposalId} />
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="title" value={title} />
        <input type="hidden" name="body" value={body} />
        <input type="hidden" name="expectedProposalRevision" value={proposalRevision} />
        <input type="hidden" name="expectedSourceBrainId" value={expectedSourceBrainId} />
        {bases.length > 1 && (
          <label className="mono" style={{ fontSize: ".6875rem" }}>
            {t("Destination base")}
            <select
              name="destBrainId"
              value={destBrain}
              onChange={(e) => {
                setDestBrain(e.target.value);
                // Reset stale source-folder selection; cross-base defaults to root.
                setDestFolder(e.target.value === currentBrainId ? "" : "__root");
              }}
              style={{ marginLeft: ".3rem" }}
            >
              {bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="mono" style={{ fontSize: ".6875rem" }}>
          {t("Destination folder")}
          <select name="destFolderId" value={destFolder} onChange={(e) => setDestFolder(e.target.value)} style={{ marginLeft: ".3rem" }}>
            {crossBase ? (
              <>
                <option value="__root">{t("Base root")}</option>
                {destFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </>
            ) : (
              <>
                <option value="">{t("Keep")}</option>
                <option value="__root">{t("Base root")}</option>
                {destFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <button className="svod-btn-ghost" type="submit" disabled={approvePending}>
          {approvePending ? t("Approving…") : t("Approve")}
        </button>
      </form>
      {approveState && "error" in approveState && (
        <p role="alert" style={{ color: "#f87171", fontSize: ".75rem", margin: 0 }}>
          {approveState.error}
        </p>
      )}
      {conflictCurrent && (
        <div style={{ border: "1px dashed #4b5563", borderRadius: 4, padding: ".5rem .6rem", fontSize: ".75rem" }}>
          <strong>{t("Current accepted version (conflict — proposal stays pending)")}</strong>
          <pre style={{ whiteSpace: "pre-wrap", margin: ".3rem 0 0" }}>
            {`${conflictCurrent.title}\n\n${conflictCurrent.body.slice(0, 1200)}${conflictCurrent.body.length > 1200 ? "…" : ""}\n\n(revision ${conflictCurrent.revision})`}
          </pre>
        </div>
      )}
    </div>
  );
}
