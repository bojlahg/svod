"use client";

import { useRef, useState, type FormEvent } from "react";
import { useT } from "@/lib/t-client";

interface PreviewAdd {
  id: string | null;
  title: string;
  status: string;
  path: string;
}
interface PreviewMatch {
  id: string;
  title: string;
  status: string;
  path: string;
}
interface PreviewConflict {
  id: string;
  title: string;
  reason: string;
}
interface PreviewResult {
  format?: string;
  adds?: PreviewAdd[];
  matches?: PreviewMatch[];
  conflicts?: PreviewConflict[];
  errors?: string[];
  added?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

/**
 * SVOD stage 6 import form: ZIP or .md set, preview then commit.
 * Plain JSON/multipart POST, local pending state, no Server Action.
 */
export function SvodImportForm({ brainId }: { brainId: string }) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [staged, setStaged] = useState<File[]>([]);

  function collectPicked(): File[] {
    const out: File[] = [];
    const f = fileRef.current?.files;
    if (f) for (const file of Array.from(f)) out.push(file);
    const d = dirRef.current?.files;
    if (d) for (const file of Array.from(d)) out.push(file);
    return out;
  }

  function formWith(files: File[]): FormData {
    const fd = new FormData();
    for (const file of files) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const name = rel && rel.length > 0 ? rel : file.name;
      fd.append("file", file, name);
    }
    return fd;
  }

  async function runPreview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const files = collectPicked();
    if (!files.length) {
      setResult({ error: t("Choose a file.") });
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/brains/${brainId}/svod-import?phase=preview`, {
        method: "POST",
        body: formWith(files),
        credentials: "same-origin",
      });
      let data: PreviewResult | null = null;
      try {
        data = (await res.json()) as PreviewResult;
      } catch {
        data = null;
      }
      if (!res.ok || !data) {
        const msg =
          data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
            ? ((data as unknown as { error: string }).error)
            : t("Could not read the archive.");
        setResult({ error: msg });
        return;
      }
      setResult(data);
      setStaged(files);
    } catch {
      setResult({ error: t("Could not read the archive.") });
    } finally {
      setPending(false);
    }
  }

  async function runCommit(decision: "update" | "skip") {
    if (!staged.length) return;
    setPending(true);
    try {
      const res = await fetch(`/api/brains/${brainId}/svod-import?phase=commit&decision=${decision}`, {
        method: "POST",
        body: formWith(staged),
        credentials: "same-origin",
      });
      let data: PreviewResult | null = null;
      try {
        data = (await res.json()) as PreviewResult;
      } catch {
        data = null;
      }
      if (!res.ok || !data) {
        const msg =
          data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
            ? ((data as unknown as { error: string }).error)
            : t("Could not import the archive.");
        setResult({ error: msg });
        return;
      }
      setResult(data);
      // Stay on the page while there are per-note errors to show; a clean
      // import reloads the whole document like the other tree operations.
      if (data.errors && data.errors.length > 0) return;
      window.location.reload();
    } catch {
      setResult({ error: t("Could not import the archive.") });
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: ".5rem", marginTop: ".6rem" }}>
      <form onSubmit={runPreview} style={{ display: "flex", gap: ".5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: ".3rem", fontSize: ".75rem", color: "#9aa3af" }}>
          {t("Archive or Markdown files")}
          <input
            ref={fileRef}
            type="file"
            name="file"
            accept=".zip,.md"
            multiple
            aria-label={t("Archive or Markdown files")}
            style={{ fontSize: ".8125rem", color: "#9aa3af", maxWidth: 260 }}
          />
        </label>
        <label style={{ display: "grid", gap: ".3rem", fontSize: ".75rem", color: "#9aa3af" }}>
          {t("Folder with Markdown")}
          <input
            ref={dirRef}
            type="file"
            // @ts-expect-error webkitdirectory is not in React types
            webkitdirectory=""
            aria-label={t("Folder with Markdown")}
            style={{ fontSize: ".8125rem", color: "#9aa3af", maxWidth: 260 }}
          />
        </label>
        <button type="submit" disabled={pending} className="svod-btn">
          {pending ? t("Reading…") : t("Import")}
        </button>
      </form>
      {result && typeof result === "object" && "error" in result && (result as { error?: string }).error ? (
        <p role="alert" style={{ color: "#f87171", fontSize: ".75rem", margin: 0 }}>
          {(result as { error: string }).error}
        </p>
      ) : null}
      {result && !("error" in (result as object)) ? (
        <div style={{ display: "grid", gap: ".4rem", fontSize: ".8125rem", color: "#9aa3af" }}>
          <p className="mono" style={{ margin: 0 }}>
            {t("Will add")}: {(result.adds ?? []).length} · {t("Matches")}: {(result.matches ?? []).length} ·{" "}
            {t("Conflicts")}: {(result.conflicts ?? []).length}
            {typeof result.added === "number" ? ` · ${t("Added")}: ${result.added} · ${t("Updated")}: ${result.updated}` : ""}
          </p>
          {(result.adds ?? []).slice(0, 20).map((a) => (
            <span key={`${a.status}-${a.path}-${a.id ?? a.title}`}>
              {t("Add")}: {a.path}
            </span>
          ))}
          {(result.matches ?? []).slice(0, 20).map((m) => (
            <span key={m.id}>
              {t("Match")}: {m.path}
            </span>
          ))}
          {(result.conflicts ?? []).slice(0, 20).map((c) => (
            <span key={c.id}>
              {t("Conflict")}: {c.title} · {c.reason}
            </span>
          ))}
          {(result.errors ?? []).slice(0, 20).map((e, i) => (
            <span key={i} role="alert" style={{ color: "#f87171" }}>
              {e}
            </span>
          ))}
          {(result.matches ?? []).length > 0 ? (
            <div style={{ display: "flex", gap: ".5rem" }}>
              <button type="button" disabled={pending} className="svod-btn" onClick={() => runCommit("update")}>
                {pending ? t("Saving…") : t("Update matches")}
              </button>
              <button type="button" disabled={pending} className="svod-btn-ghost" onClick={() => runCommit("skip")}>
                {pending ? t("Saving…") : t("Skip matches")}
              </button>
            </div>
          ) : (result.adds ?? []).length > 0 ? (
            <div style={{ display: "flex", gap: ".5rem" }}>
              <button type="button" disabled={pending} className="svod-btn" onClick={() => runCommit("skip")}>
                {pending ? t("Saving…") : t("Import")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
