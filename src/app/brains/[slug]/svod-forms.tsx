"use client";

import { useActionState } from "react";
import { useT } from "@/lib/t-client";
import {
  createFolder,
  renameFolder,
  renameBase,
  moveSvodNoteAction,
} from "./svod-actions";

type ActionState = { error?: string; ok?: boolean } | null;

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
  const [state, action, pending] = useActionState(
    (_prev: ActionState, formData: FormData) => renameBase(formData),
    null,
  );
  return (
    <form action={action} style={{ display: "flex", gap: ".35rem", marginBottom: ".6rem" }}>
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
  const [state, action, pending] = useActionState(
    (_prev: ActionState, formData: FormData) => createFolder(formData),
    null,
  );
  if (compact) {
    return (
      <form action={action} style={{ display: "flex", gap: ".35rem", marginTop: ".35rem" }}>
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
    <form action={action} style={{ display: "grid", gap: ".4rem", marginTop: ".5rem" }}>
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
  const [state, action, pending] = useActionState(
    (_prev: ActionState, formData: FormData) => renameFolder(formData),
    null,
  );
  return (
    <form action={action} style={{ display: "flex", gap: ".25rem" }}>
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
  const [state, action, pending] = useActionState(
    (_prev: ActionState, formData: FormData) => moveSvodNoteAction(formData),
    null,
  );
  return (
    <form action={action} style={{ display: "flex", gap: ".35rem", alignItems: "center", flexWrap: "wrap" }}>
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
