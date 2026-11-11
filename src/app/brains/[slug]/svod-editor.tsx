"use client";

import { useActionState, useState } from "react";
import { useT } from "@/lib/t-client";
import { MARKDOWN_HELP_EXAMPLES } from "@/lib/svod-markdown";
import SvodMarkdown from "@/components/SvodMarkdown";
import { createSvodNoteAction, editSvodNoteAction } from "@/app/brains/[slug]/svod-actions";

/**
 * SVOD stage 3 Markdown editor: collapsible syntax help (5 examples), live
 * preview with the same renderer as reading, explicit save. The stored body
 * stays literal — preview never writes back.
 */
export default function SvodEditor({
  brainId,
  slug,
  noteId,
  folderId,
  folders,
  initialTitle,
  initialBody,
  mode,
}: {
  brainId: string;
  slug: string;
  noteId?: string;
  folderId: string | null;
  folders: { id: string; name: string; path: string }[];
  initialTitle: string;
  initialBody: string;
  mode: "create" | "edit";
}) {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [showPreview, setShowPreview] = useState(true);
  const [targetFolder, setTargetFolder] = useState<string>(folderId ?? "");

  const save = async (_prev: unknown, formData: FormData) => {
    formData.set("title", title);
    formData.set("body", body);
    if (mode === "edit" && noteId) {
      return editSvodNoteAction(formData);
    }
    return createSvodNoteAction(formData);
  };
  const [state, action, pending] = useActionState(save, null as { error?: string; ok?: boolean; id?: string } | null);

  return (
    <div style={{ display: "grid", gap: ".75rem" }}>
      <details style={{ border: "1px solid #2a2e35", borderRadius: 6, padding: ".6rem .8rem", background: "#101216" }}>
        <summary style={{ cursor: "pointer", fontSize: ".8125rem", color: "#9aa3af" }}>
          {t("Markdown syntax help")}
        </summary>
        <div style={{ display: "grid", gap: ".6rem", marginTop: ".6rem" }}>
          {MARKDOWN_HELP_EXAMPLES.map((ex) => (
            <div key={ex.title} style={{ fontSize: ".8125rem" }}>
              <div style={{ color: "#e6e8ea", fontWeight: 600, marginBottom: ".2rem" }}>{ex.title}</div>
              <pre
                style={{
                  margin: 0,
                  padding: ".5rem .6rem",
                  background: "#0b0d10",
                  border: "1px solid #2a2e35",
                  borderRadius: 4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "#9aa3af",
                  fontSize: ".75rem",
                }}
              >
                {ex.sample}
              </pre>
            </div>
          ))}
        </div>
      </details>

      <form action={action} style={{ display: "grid", gap: ".6rem" }}>
        <input type="hidden" name="brainId" value={brainId} />
        <input type="hidden" name="slug" value={slug} />
        {noteId ? <input type="hidden" name="noteId" value={noteId} /> : null}
        <input type="hidden" name="folderId" value={targetFolder} />

        <label style={{ display: "grid", gap: ".3rem", fontSize: ".8125rem", color: "#9aa3af" }}>
          {t("Title")}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            placeholder={t("Searchable title")}
            aria-label={t("Title")}
            style={{
              padding: ".6rem .7rem",
              background: "#0b0d10",
              border: "1px solid #2a2e35",
              borderRadius: 6,
              color: "#e6e8ea",
              font: "inherit",
            }}
          />
        </label>

        {mode === "create" && (
          <label style={{ display: "grid", gap: ".3rem", fontSize: ".8125rem", color: "#9aa3af" }}>
            {t("Folder")}
            <select
              value={targetFolder}
              onChange={(e) => setTargetFolder(e.target.value)}
              style={{
                padding: ".55rem .6rem",
                background: "#0b0d10",
                border: "1px solid #2a2e35",
                borderRadius: 6,
                color: "#e6e8ea",
                font: "inherit",
              }}
            >
              <option value="">{t("Base root")}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path ? `${f.path} / ${f.name}` : f.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label style={{ display: "grid", gap: ".3rem", fontSize: ".8125rem", color: "#9aa3af" }}>
          {t("Markdown body")}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            required
            placeholder={t("Write Markdown here — headings, lists, tables, links, code. Saved exactly as typed.")}
            aria-label={t("Markdown body")}
            style={{
              padding: ".7rem .8rem",
              background: "#0b0d10",
              border: "1px solid #2a2e35",
              borderRadius: 6,
              color: "#e6e8ea",
              font: "inherit",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: ".875rem",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          />
        </label>

        <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="submit"
            disabled={pending}
            className="svod-btn"
            style={{ opacity: pending ? 0.6 : 1 }}
          >
            {pending ? t("Saving…") : mode === "edit" ? t("Save changes") : t("Create note")}
          </button>
          <button
            type="button"
            className="svod-btn-ghost"
            onClick={() => setShowPreview((v) => !v)}
            aria-expanded={showPreview}
          >
            {showPreview ? t("Hide preview") : t("Show preview")}
          </button>
          <span className="mono" style={{ fontSize: ".6875rem", color: "#6b7280" }}>
            {body.length} / 100000
          </span>
        </div>

        {state && "error" in state && state?.error ? (
          <p role="alert" style={{ color: "#f87171", fontSize: ".8125rem", margin: 0 }}>
            {state.error}
          </p>
        ) : null}
        {state && "ok" in state && state?.ok ? (
          <p style={{ color: "#34d399", fontSize: ".8125rem", margin: 0 }}>
            {t("Saved.")}
          </p>
        ) : null}
      </form>

      {showPreview && (
        <div>
          <p className="mono" style={{ fontSize: ".6875rem", color: "#6b7280", margin: "0 0 .3rem" }}>
            {t("Preview — same rendering as reading")}
          </p>
          <SvodMarkdown body={body} />
        </div>
      )}
    </div>
  );
}
