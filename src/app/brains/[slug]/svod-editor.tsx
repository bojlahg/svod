"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/t-client";
import { MARKDOWN_HELP_EXAMPLES } from "@/lib/svod-markdown";
import SvodMarkdown from "@/components/SvodMarkdown";
import { createSvodNoteAction, editSvodNoteAction } from "@/app/brains/[slug]/svod-actions";
import {
  svodIsDirty,
  svodSavedAfterSuccess,
  svodSaveStatus,
  type SvodEditorSnapshot,
} from "@/lib/svod-editor-state";
import {
  clearSvodUnsavedDraftForNavigation,
  setSvodUnsavedDraft,
} from "./svod-draft-guard";

function isSvodUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

/**
 * Workspace note editor: sticky Save + real save status, Ctrl/Cmd+S,
 * Markdown toolbar, source and the SAME SvodMarkdown preview side by side.
 *
 * Transport stays the existing JSON workspace POST (literal title/body bytes
 * through JSON — BOM/newlines untouched, no trim). A successful create
 * navigates to the returned stable note ID so a repeated save edits instead
 * of duplicating; errors keep the draft; edits typed while a save is in
 * flight stay dirty against the SUBMITTED snapshot.
 */
export default function SvodEditor({
  brainId,
  slug,
  baseHref,
  noteId,
  folderId,
  folders,
  initialTitle,
  initialBody,
  folderLabel,
  mode,
}: {
  brainId: string;
  slug: string;
  baseHref: string;
  noteId?: string;
  folderId: string | null;
  folders: { id: string; name: string; path: string }[];
  initialTitle: string;
  initialBody: string;
  folderLabel: string;
  mode: "create" | "edit";
}) {
  const t = useT();
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [saved, setSaved] = useState<SvodEditorSnapshot>({
    title: initialTitle,
    body: initialBody,
  });
  const [targetFolder, setTargetFolder] = useState<string>(folderId ?? "");
  const [showPreview, setShowPreview] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [focusOn, setFocusOn] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Latest values for the in-flight race: a keystroke that lands while the
  // create/edit POST is pending must survive success (stays dirty).
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  useEffect(() => {
    titleRef.current = title;
    bodyRef.current = body;
  }, [title, body]);

  const effectiveNoteId = mode === "edit" ? (noteId ?? null) : createdId;
  const effectiveOp = effectiveNoteId ? "noteedit" : "notecreate";
  const current: SvodEditorSnapshot = { title, body };
  const dirty = svodIsDirty(current, saved);
  const status = svodSaveStatus({ pending, dirty, error });

  useEffect(() => {
    setSvodUnsavedDraft(dirty);
    return () => setSvodUnsavedDraft(false);
  }, [dirty]);

  // Focus mode drives the workspace shell attribute; always clean up on
  // unmount / note change so Reading never loses its sidebar with no toggle.
  useEffect(() => {
    try {
      document
        .querySelector(".svod-ws")
        ?.setAttribute("data-focus", focusOn ? "on" : "off");
    } catch {
      /* noop */
    }
  }, [focusOn]);
  useEffect(() => {
    return () => {
      try {
        document.querySelector(".svod-ws")?.setAttribute("data-focus", "off");
      } catch {
        /* noop */
      }
    };
  }, [noteId, mode]);

  // Native/SSR fallback keeps server guards: hydrated path below does the
  // JSON POST; without JS the named inputs post through the server action.
  const saveFallback = async (_prev: unknown, formData: FormData) => {
    if (formData.get("title") === null) formData.set("title", title);
    if (formData.get("body") === null) formData.set("body", body);
    if (effectiveNoteId) {
      formData.set("noteId", effectiveNoteId);
      return editSvodNoteAction(formData);
    }
    return createSvodNoteAction(formData);
  };
  const [, fallbackAction] = useActionState(saveFallback, null);

  function insertSnippet(kind: "heading" | "list" | "code" | "link") {
    const el = areaRef.current;
    const snippets: Record<string, string> = {
      heading: "\n## Heading\n",
      list: "\n- Item\n",
      code: "\n```\ncode\n```\n",
      link: "[Text](https://example.com)",
    };
    const snippet = snippets[kind];
    if (!el) {
      setBody((b) => `${b}${snippet}`);
      return;
    }
    // The textarea DOM normalises CRLF to LF: slice the live DOM value with
    // its own selection offsets so the snippet lands where requested.
    const domValue = el.value;
    const start = el.selectionStart ?? domValue.length;
    const end = el.selectionEnd ?? domValue.length;
    const next = `${domValue.slice(0, start)}${snippet}${domValue.slice(end)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function toggleFocus() {
    setFocusOn((v) => !v);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    // Snapshot at submit time: success marks THESE values saved, so typing
    // during the request stays dirty afterwards.
    const submitted: SvodEditorSnapshot = { title, body };
    const wasCreate = !effectiveNoteId;
    setError(null);
    try {
      const fields: Record<string, string> = {
        op: effectiveOp,
        brainId,
        slug,
        title: submitted.title,
        body: submitted.body,
      };
      if (effectiveNoteId) fields.noteId = effectiveNoteId;
      else if (targetFolder) fields.folderId = targetFolder;
      const res = await fetch(`/api/brains/${brainId}/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
        credentials: "same-origin",
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      const okShape =
        res.ok &&
        !!data &&
        typeof data === "object" &&
        (data as { ok?: unknown }).ok === true;
      if (!okShape) {
        const msg =
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error ?? "")
            : "";
        setError(msg || t("Could not save. Check the connection and retry."));
        return;
      }
      const rawId =
        "id" in (data as object)
          ? (data as { id?: unknown }).id
          : null;
      if (wasCreate && !isSvodUuid(rawId)) {
        // Malformed success: keep the draft, never fake Saved.
        setError(t("Could not save. Check the connection and retry."));
        return;
      }
      const newId = wasCreate ? String(rawId) : null;
      // Latest live values vs submitted: typing during the POST must survive.
      const latest: SvodEditorSnapshot = {
        title: titleRef.current,
        body: bodyRef.current,
      };
      const hasNewerEdits =
        latest.title !== submitted.title || latest.body !== submitted.body;
      // Success marks the SUBMITTED snapshot saved (not the live textarea),
      // so a keystroke landing in-flight stays dirty.
      setSaved(svodSavedAfterSuccess(submitted));
      if (wasCreate && newId) {
        // Promote the stable ID immediately so a repeated save edits.
        setCreatedId(newId);
        const canonical = `${baseHref}?note=${encodeURIComponent(newId)}&edit=1`;
        if (hasNewerEdits) {
          // Dirty first create: canonicalize the URL but DO NOT refresh or
          // remount — a refresh would swap key `new-*` for the returned ID
          // and remount with the submitted body, wiping newer text. Retain
          // current state; the next save edits the promoted ID.
          try {
            window.history.replaceState(null, "", canonical);
          } catch {
            /* noop */
          }
          return;
        }
        // Clean create: clear the guard synchronously for this legitimate
        // navigation, otherwise beforeunload fires on top of the save.
        clearSvodUnsavedDraftForNavigation();
        window.location.assign(canonical);
        return;
      }
      if (hasNewerEdits) {
        // Edit (or promoted-create) save with newer typing in flight: retain
        // state, no refresh/remount, so the newer text is never overwritten.
        return;
      }
      // Clean edit: safe to refresh now that live === submitted; clear the
      // guard synchronously first.
      clearSvodUnsavedDraftForNavigation();
      router.refresh();
    } catch {
      setError(t("Could not save. Check the connection and retry."));
    } finally {
      setPending(false);
      busyRef.current = false;
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusText =
    status === "saving"
      ? t("Saving…")
      : status === "unsaved"
        ? t("Unsaved changes")
        : status === "save-error"
          ? (error ?? t("Could not save. Check the connection and retry."))
          : t("Saved");

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div className="svod-ws-savebar">
        <div className="svod-ws-titlewrap">
          <input
            className="svod-ws-titleinput"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            placeholder={t("Note title")}
            aria-label={t("Note title")}
          />
          <span className="svod-ws-savestate" role="status" data-state={status === "save-error" ? "error" : status === "unsaved" ? "unsaved" : status === "saving" ? "saving" : "saved"}>
            {statusText}
          </span>
        </div>
        <div className="svod-ws-actions">
          <button
            type="button"
            className="svod-ws-btn"
            onClick={toggleFocus}
            aria-pressed={focusOn}
            aria-label={focusOn ? t("Show navigation") : t("Hide navigation")}
            title={t("Focus mode")}
          >
            {focusOn ? t("Show sidebar") : t("Focus")}
          </button>
          <button
            type="button"
            className="svod-ws-btn"
            onClick={() => setShowPreview((v) => !v)}
            aria-pressed={showPreview}
          >
            {showPreview ? t("Hide preview") : t("Show preview")}
          </button>
          <button
            type="submit"
            form="svod-note-form"
            className="svod-ws-btn svod-ws-btn-primary"
            disabled={pending}
          >
            {pending ? t("Saving…") : mode === "edit" || effectiveNoteId ? t("Save") : t("Create note")}
          </button>
        </div>
      </div>

      <div className="svod-ws-toolbar">
        <div className="svod-ws-actions" role="toolbar" aria-label={t("Formatting")}>
          <button type="button" className="svod-ws-btn" onClick={() => insertSnippet("heading")} aria-label={t("Insert heading")}>
            {"H2"}
          </button>
          <button type="button" className="svod-ws-btn" onClick={() => insertSnippet("list")} aria-label={t("Insert list")}>
            {t("List")}
          </button>
          <button type="button" className="svod-ws-btn" onClick={() => insertSnippet("code")} aria-label={t("Insert code block")}>
            {t("Code")}
          </button>
          <button type="button" className="svod-ws-btn" onClick={() => insertSnippet("link")} aria-label={t("Insert link")}>
            {t("Link")}
          </button>
          <button
            type="button"
            className="svod-ws-btn"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
          >
            {t("Syntax")}
          </button>
        </div>
        <span style={{ fontSize: ".75rem", color: "#a1aabc" }}>
          {body.length} / 100000
        </span>
      </div>

      {showHelp && (
        <div className="svod-ws-help">
          <div style={{ display: "grid", gap: ".5rem" }}>
            {MARKDOWN_HELP_EXAMPLES.map((ex) => (
              <div key={ex.title} style={{ fontSize: ".8125rem" }}>
                <div style={{ color: "#e2e6ef", fontWeight: 600, marginBottom: ".15rem" }}>{ex.title}</div>
                <pre
                  style={{
                    margin: 0, padding: ".5rem .6rem", background: "#14161b",
                    border: "1px solid #2c313b", borderRadius: 6,
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                    color: "#a1aabc", fontSize: ".75rem",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  {ex.sample}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      <form
        ref={formRef}
        id="svod-note-form"
        action={fallbackAction}
        onSubmit={handleSubmit}
        style={{ display: "contents" }}
      >
        <input type="hidden" name="brainId" value={brainId} />
        <input type="hidden" name="slug" value={slug} />
        {effectiveNoteId ? <input type="hidden" name="noteId" value={effectiveNoteId} /> : null}

        <div className="svod-ws-editgrid" data-preview={showPreview ? "on" : "off"}>
          <div className="svod-ws-source">
            <div className="svod-ws-sectitle">
              <span>{t("Markdown")}</span>
              <span>{mode === "create" && !effectiveNoteId ? t("New note") : folderLabel}</span>
            </div>
            {mode === "create" && !effectiveNoteId && (
              <label style={{ display: "grid", gap: ".3rem", fontSize: ".8125rem", color: "#a1aabc", marginBottom: ".6rem" }}>
                {t("Folder")}
                <select
                  name="folderId"
                  value={targetFolder}
                  onChange={(e) => setTargetFolder(e.target.value)}
                  aria-label={t("Folder")}
                  style={{
                    padding: ".5rem .6rem", background: "#14161b",
                    border: "1px solid #2c313b", borderRadius: 6,
                    color: "#e2e6ef", font: "inherit", fontSize: ".875rem",
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
            <label className="svod-ws-sectitle" htmlFor="svod-body" style={{ marginBottom: ".4rem" }}>
              <span>{t("Text")}</span>
            </label>
            <textarea
              ref={areaRef}
              id="svod-body"
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              placeholder={t("Write Markdown here — headings, lists, tables, links, code. Saved exactly as typed.")}
              aria-label={t("Markdown body")}
              spellCheck={false}
            />
            {/* Controlled title already ships via JSON; the hidden input keeps
                the no-JS fallback posting the same field name. */}
            <input type="hidden" name="title" value={title} />
            {status === "save-error" && error && (
              <p role="alert" className="svod-ws-error" style={{ margin: ".6rem 0 0" }}>
                {error}
              </p>
            )}
          </div>
          {showPreview && (
            <div className="svod-ws-preview" aria-label={t("Preview")}>
              <div className="svod-ws-sectitle">
                <span>{t("Preview")}</span>
              </div>
              <SvodMarkdown body={body} />
            </div>
          )}
        </div>
      </form>

      <footer className="svod-ws-footbar">
        <span>{t("Markdown · UTF-8")}</span>
        <span>{t("Ctrl + S — save")}</span>
      </footer>
    </div>
  );
}
