"use client";

import { useActionState, useRef } from "react";
import { useT } from "@/lib/t-client";
import { uploadMdAction } from "@/app/brains/[slug]/svod-actions";

/**
 * One uploaded UTF-8 .md becomes one note in the selected folder.
 * Reasonable limits + visible feedback; batch/ZIP import is stage 6.
 */
export default function SvodUpload({
  brainId,
  slug,
  folders,
  currentFolder,
}: {
  brainId: string;
  slug: string;
  folders: { id: string; name: string; path: string }[];
  currentFolder: string | null;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, action, pending] = useActionState(uploadMdAction, null);

  return (
    <form
      action={action}
      style={{ display: "flex", gap: ".5rem", alignItems: "flex-end", flexWrap: "wrap" }}
    >
      <input type="hidden" name="brainId" value={brainId} />
      <input type="hidden" name="slug" value={slug} />
      <label style={{ display: "grid", gap: ".3rem", fontSize: ".75rem", color: "#9aa3af" }}>
        {t("Folder for upload")}
        <select
          name="folderId"
          defaultValue={currentFolder ?? ""}
          style={{
            padding: ".5rem .6rem",
            background: "#0b0d10",
            border: "1px solid #2a2e35",
            borderRadius: 6,
            color: "#e6e8ea",
            font: "inherit",
            fontSize: ".8125rem",
            maxWidth: 220,
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
      <label style={{ display: "grid", gap: ".3rem", fontSize: ".75rem", color: "#9aa3af" }}>
        {t(".md file (UTF-8, max 200 KB)")}
        <input
          ref={inputRef}
          type="file"
          name="file"
          accept=".md,text/markdown"
          required
          aria-label={t(".md file (UTF-8, max 200 KB)")}
          style={{ fontSize: ".8125rem", color: "#9aa3af", maxWidth: 240 }}
        />
      </label>
      <button type="submit" disabled={pending} className="svod-btn">
        {pending ? t("Uploading…") : t("Upload .md")}
      </button>
      {state && typeof state === "object" && "error" in state && state?.error ? (
        <span role="alert" style={{ color: "#f87171", fontSize: ".75rem" }}>
          {(state as { error: string }).error}
        </span>
      ) : null}
      {state && typeof state === "object" && "ok" in state && (state as { ok?: boolean }).ok ? (
        <span style={{ color: "#34d399", fontSize: ".75rem" }}>
          {t("Uploaded.")}
        </span>
      ) : null}
    </form>
  );
}
