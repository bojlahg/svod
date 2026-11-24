"use client";

import { useState } from "react";
import { useT } from "@/lib/t-client";
import ConfirmForm from "@/components/ConfirmForm";
import { deleteSvodNoteAction } from "./svod-actions";
import { SvodNoteMoveForm } from "./svod-forms";
import { confirmSvodDiscard } from "./svod-draft-guard";

/**
 * Reading-pane contextual actions: a single menu instead of always-visible
 * destructive/rename forms. Move stays the existing guarded form, delete
 * stays the existing confirm action, download is a plain link, copy writes
 * the stable note URL (same ID after moves between folders). Move/Delete are
 * editor-only (backend denies readers); download + stable-link copy stay
 * available to all canRead users.
 */
export default function SvodNoteMenu({
  brainId,
  slug,
  baseHref,
  noteId,
  currentFolder,
  folders,
  canEdit,
}: {
  brainId: string;
  slug: string;
  baseHref: string;
  noteId: string;
  currentFolder: string | null;
  folders: { id: string; label: string }[];
  canEdit: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const url = `${window.location.origin}${baseHref}?note=${noteId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="svod-ws-menu">
      <summary className="svod-ws-btn" aria-label={t("Note actions")}>
        {t("Actions")}
      </summary>
      <div className="svod-ws-menu-panel">
        {canEdit && (
          <>
            <span style={{ fontSize: ".75rem", color: "#a1aabc" }}>{t("Move to folder")}</span>
            <SvodNoteMoveForm
              brainId={brainId}
              slug={slug}
              noteId={noteId}
              currentFolder={currentFolder}
              folders={folders}
            />
          </>
        )}
        <a className="svod-ws-btn" href={`/api/brains/${brainId}/notes/${noteId}/download`}>
          {t("Download .md")}
        </a>
        <button
          type="button"
          className="svod-ws-btn"
          onClick={copyLink}
          onBlur={() => setCopied(false)}
        >
          {copied ? t("Link copied") : t("Copy stable link")}
        </button>
        {canEdit && (
          <ConfirmForm
            action={deleteSvodNoteAction}
            message={t("Delete this note? This cannot be undone.")}
          >
            <input type="hidden" name="brainId" value={brainId} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="noteId" value={noteId} />
            <button
              type="submit"
              className="svod-ws-btn"
              style={{ color: "#f3a3ad" }}
              onClick={(e) => {
                if (!confirmSvodDiscard(t)) {
                  e.preventDefault();
                }
              }}
            >
              {t("Delete")}
            </button>
          </ConfirmForm>
        )}
      </div>
    </details>
  );
}
