"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/t-client";
import {
  createFolder,
  renameFolder,
  renameBase,
  moveSvodNoteAction,
  refreshSvodIndexAction,
  setSvodAutoIndexAction,
} from "./svod-actions";

type ActionState = { error?: string; ok?: boolean } | null;

export type SvodWorkspaceOp =
  | "foldercreate"
  | "folderrename"
  | "baserename"
  | "notemove"
  | "notecreate"
  | "noteedit"
  | "markdownupload"
  | "indexrefresh"
  | "indexauto";

// router.refresh() stays unreliable for tree reads in this production build,
// so the four small tree ops reload the document after a successful JSON
// response (same URL/query preserved); note/upload keep soft refresh.
const HARD_RELOAD_OPS: ReadonlySet<SvodWorkspaceOp> = new Set([
  "baserename",
  "foldercreate",
  "folderrename",
  "notemove",
]);

/**
 * Shared JSON-transport helper (JSON text, multipart File, no Flight).
 * Native server actions stay as SSR fallback; hydrated sends JSON except upload.
 */
export function useSvodWorkspaceSubmit<R extends { ok?: unknown; error?: unknown }>(
  brainId: string,
  op: SvodWorkspaceOp,
  prepare?: (fd: FormData) => void,
) {
  const router = useRouter();
  const t = useT();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<(R | { error: string }) | null>(null);
  const busyRef = useRef(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    try {
      const fd = new FormData(e.currentTarget);
      prepare?.(fd);
      fd.set("op", op);
      fd.set("brainId", brainId);
      const url = `/api/brains/${brainId}/workspace`;
      const fields: Record<string, string> = {};
      for (const [name, value] of fd.entries()) {
        if (typeof value === "string" && !name.startsWith("$ACTION")) {
          fields[name] = value;
        }
      }
      const res =
        op === "markdownupload"
          ? await fetch(url, { method: "POST", body: fd, credentials: "same-origin" })
          : await fetch(url, {
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
      if (!res.ok || !data || typeof data !== "object") {
        const msg =
          data && typeof data === "object" && "error" in data
            ? (data as { error?: unknown }).error
            : null;
        setResult({
          error:
            typeof msg === "string" && msg
              ? msg
              : t("Could not save. Check the connection and retry."),
        } as R | { error: string });
      } else {
        setResult(data as R | { error: string });
        if ("ok" in data && (data as { ok?: unknown }).ok) {
          if (HARD_RELOAD_OPS.has(op)) {
            window.location.reload();
          } else {
            router.refresh();
          }
        }
      }
    } catch {
      setResult({ error: t("Could not save. Check the connection and retry.") } as R | { error: string });
    } finally {
      setPending(false);
      busyRef.current = false;
    }
  }

  return { pending, result, onSubmit };
}

function ErrorLine({ state }: { state: ActionState }) {
  if (!state || !("error" in state) || !state.error) return null;
  return (
    <p role="alert" style={{ color: "#f87171", fontSize: ".75rem", margin: 0 }}>
      {state.error}
    </p>
  );
}

export function SvodBaseRenameForm({
  brainId,
  initialTitle,
}: {
  brainId: string;
  initialTitle: string;
}) {
  const t = useT();
  const [fallbackState, fallbackAction, fallbackPending] = useActionState(
    (_prev: ActionState, formData: FormData) => renameBase(formData),
    null,
  );
  const direct = useSvodWorkspaceSubmit<ActionState & { ok?: boolean }>(brainId, "baserename");
  const pending = direct.pending || fallbackPending;
  const state = (direct.result as ActionState) ?? fallbackState;
  return (
    <form action={fallbackAction} method="post" onSubmit={direct.onSubmit} style={{ display: "flex", gap: ".35rem", marginBottom: ".6rem" }}>
      <input type="hidden" name="brainId" value={brainId} />
      <input
        name="title"
        defaultValue={initialTitle}
        required
        maxLength={80}
        aria-label={t("Rename base")}
        className="svod-input svod-input-sm"
      />
      <button className="svod-btn-ghost" type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Rename base")}
      </button>
      <ErrorLine state={state} />
    </form>
  );
}

export function SvodFolderCreateForm({
  brainId,
  slug,
  parents,
  defaultParent,
  compact,
}: {
  brainId: string;
  slug: string;
  parents: { id: string; label: string }[];
  defaultParent?: string;
  compact?: boolean;
}) {
  const t = useT();
  const [fallbackState, fallbackAction, fallbackPending] = useActionState(
    (_prev: ActionState, formData: FormData) => createFolder(formData),
    null,
  );
  const direct = useSvodWorkspaceSubmit<ActionState & { ok?: boolean }>(brainId, "foldercreate");
  const pending = direct.pending || fallbackPending;
  const state = (direct.result as ActionState) ?? fallbackState;
  if (compact) {
    return (
      <form action={fallbackAction} method="post" onSubmit={direct.onSubmit} style={{ display: "flex", gap: ".35rem", marginTop: ".35rem" }}>
        <input type="hidden" name="brainId" value={brainId} />
        <input type="hidden" name="slug" value={slug} />
        <input
          name="name"
          required
          maxLength={120}
          placeholder={t("New root folder…")}
          aria-label={t("New root folder name")}
          className="svod-input svod-input-sm"
        />
        <button className="svod-btn-ghost" type="submit" disabled={pending} aria-label={t("Create folder")}>
          {t("+")}
        </button>
        <ErrorLine state={state} />
      </form>
    );
  }
  return (
    <form action={fallbackAction} method="post" onSubmit={direct.onSubmit} style={{ display: "grid", gap: ".4rem", marginTop: ".5rem" }}>
      <input type="hidden" name="brainId" value={brainId} />
      <input type="hidden" name="slug" value={slug} />
      <input
        name="name"
        required
        maxLength={120}
        placeholder={t("Folder name")}
        aria-label={t("Folder name")}
        className="svod-input svod-input-sm"
      />
      <select
        name="parentId"
        defaultValue={defaultParent ?? ""}
        className="svod-input svod-input-sm"
        aria-label={t("Parent folder")}
      >
        <option value="">{t("Base root")}</option>
        {parents.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <button className="svod-btn" type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Create folder")}
      </button>
      <ErrorLine state={state} />
    </form>
  );
}

export function SvodFolderRenameForm({
  brainId,
  folderId,
  currentName,
}: {
  brainId: string;
  folderId: string;
  currentName: string;
}) {
  const t = useT();
  const [fallbackState, fallbackAction, fallbackPending] = useActionState(
    (_prev: ActionState, formData: FormData) => renameFolder(formData),
    null,
  );
  const direct = useSvodWorkspaceSubmit<ActionState & { ok?: boolean }>(brainId, "folderrename");
  const pending = direct.pending || fallbackPending;
  const state = (direct.result as ActionState) ?? fallbackState;
  return (
    <form action={fallbackAction} method="post" onSubmit={direct.onSubmit} style={{ display: "flex", gap: ".25rem" }}>
      <input type="hidden" name="brainId" value={brainId} />
      <input type="hidden" name="folderId" value={folderId} />
      <input
        name="name"
        defaultValue={currentName}
        required
        maxLength={120}
        aria-label={t("Rename folder")}
        className="svod-input svod-input-sm"
        style={{ width: 110 }}
      />
      <button className="svod-btn-ghost" type="submit" disabled={pending} aria-label={t("Rename folder")}>
        {pending ? t("Saving…") : t("Rename")}
      </button>
      <ErrorLine state={state} />
    </form>
  );
}

export function SvodNoteMoveForm({
  brainId,
  slug,
  noteId,
  currentFolder,
  folders,
}: {
  brainId: string;
  slug: string;
  noteId: string;
  currentFolder: string | null;
  folders: { id: string; label: string }[];
}) {
  const t = useT();
  const [fallbackState, fallbackAction, fallbackPending] = useActionState(
    (_prev: ActionState, formData: FormData) => moveSvodNoteAction(formData),
    null,
  );
  const direct = useSvodWorkspaceSubmit<ActionState & { ok?: boolean }>(brainId, "notemove");
  const pending = direct.pending || fallbackPending;
  const state = (direct.result as ActionState) ?? fallbackState;
  return (
    <form action={fallbackAction} method="post" onSubmit={direct.onSubmit} style={{ display: "flex", gap: ".35rem", alignItems: "center", flexWrap: "wrap" }}>
      <input type="hidden" name="brainId" value={brainId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="noteId" value={noteId} />
      <select
        name="folderId"
        defaultValue={currentFolder ?? ""}
        aria-label={t("Move note to folder")}
        className="svod-input svod-input-sm"
      >
        <option value="">{t("Base root")}</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <button className="svod-btn-ghost" type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Move")}
      </button>
      <ErrorLine state={state} />
    </form>
  );
}

export function SvodIndexRefreshForm({ brainId }: { brainId: string }) {
  const t = useT();
  const [fallbackState, fallbackAction, fallbackPending] = useActionState(
    (_prev: ActionState, formData: FormData) => refreshSvodIndexAction(formData),
    null,
  );
  const direct = useSvodWorkspaceSubmit<ActionState & { ok?: boolean; queued?: number }>(
    brainId,
    "indexrefresh",
  );
  const pending = direct.pending || fallbackPending;
  const state = (direct.result as ActionState) ?? fallbackState;
  return (
    <form action={fallbackAction} method="post" onSubmit={direct.onSubmit} style={{ display: "flex", gap: ".35rem", alignItems: "center" }}>
      <input type="hidden" name="brainId" value={brainId} />
      <button className="svod-btn" type="submit" disabled={pending}>
        {pending ? t("Refreshing…") : t("Refresh embeddings")}
      </button>
      <ErrorLine state={state} />
    </form>
  );
}

export function SvodAutoIndexForm({ brainId, initial }: { brainId: string; initial: boolean }) {
  const t = useT();
  const [fallbackState, fallbackAction, fallbackPending] = useActionState(
    (_prev: ActionState, formData: FormData) => setSvodAutoIndexAction(formData),
    null,
  );
  // No local toggle state: the checkbox carries the desired value (checked =
  // enabled) and the server is the authority — a successful JSON submit soft
  // refreshes the page, which re-renders with the new `initial`.
  const direct = useSvodWorkspaceSubmit<ActionState & { ok?: boolean }>(brainId, "indexauto");
  const pending = direct.pending || fallbackPending;
  const state = (direct.result as ActionState) ?? fallbackState;
  return (
    <form
      action={fallbackAction}
      method="post"
      onSubmit={direct.onSubmit}
      style={{ display: "flex", gap: ".35rem", alignItems: "center" }}
    >
      <input type="hidden" name="brainId" value={brainId} />
      <label style={{ display: "flex", gap: ".35rem", alignItems: "center", fontSize: ".8125rem" }}>
        <input
          type="checkbox"
          name="enabled"
          value="1"
          defaultChecked={initial}
          disabled={pending}
          aria-label={t("Auto-index new sections")}
        />
        {t("Auto-index")}
      </label>
      <button className="svod-btn-ghost" type="submit" disabled={pending}>
        {pending ? t("Saving…") : t("Save")}
      </button>
      <ErrorLine state={state} />
    </form>
  );
}
