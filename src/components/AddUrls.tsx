"use client";

import { useT } from "@/lib/t-client";
import { markup } from "@/lib/markup";
import { useActionState, useState } from "react";
import { addUrls } from "@/app/brains/[slug]/source-actions";

/**
 * Docs pages are where most of a brain's material actually lives, and taking
 * screenshots of a documentation site to feed it is absurd. Paste the links.
 */
export default function AddUrls({ slug }: { slug: string }) {
  const t = useT();

  const [open, setOpen] = useState(false);
  const [crawl, setCrawl] = useState(false);
  const [state, action, pending] = useActionState(addUrls, null);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="navlink"
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
      >
        {t("or add pages by URL →")}</button>
    );
  }

  return (
    <form action={action} className="panel" style={{ display: "grid", gap: ".6rem" }}>
      <input type="hidden" name="slug" value={slug} />
      <label style={{ display: "grid", gap: ".35rem" }}>
        <span style={{ fontWeight: 600 }}>{t("Add pages by URL")}</span>
        <span className="mono" style={{ fontSize: ".75rem", color: "var(--ink-2)" }}>
          {crawl
            ? t("One link — the root of the docs. Every page in that section is found and read: sitemap, GitHub repository, or by following links.")
            : t("One per line, up to 25. Each page is fetched and read like any other source.")}
        </span>
      </label>

      <label
        className="mono"
        style={{ display: "flex", gap: ".5rem", alignItems: "center", fontSize: ".8125rem" }}
      >
        {markup(t("<0/> Learn the whole site from one link"), [
        <input key="s0"
          type="checkbox"
          name="crawl"
          checked={crawl}
          onChange={(e) => setCrawl(e.target.checked)}
        />,
      ])}</label>

      <textarea
        name="urls"
        rows={crawl ? 1 : 4}
        autoFocus
        placeholder={
          crawl
            ? "https://example.com/docs  (or github.com/owner/repo)"
            : "https://example.com/docs/spacing\nhttps://example.com/docs/colour"
        }
        style={{
          width: "100%",
          padding: ".7rem .85rem",
          border: "1.5px solid var(--ink)",
          background: "var(--paper)",
          font: "inherit",
          fontSize: ".9375rem",
        }}
      />

      {state?.error && (
        <p className="mono" style={{ color: "var(--color-riso-red)", fontSize: ".8125rem", margin: 0 }}>
          {state.error}
        </p>
      )}

      <p className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)" }}>
        {t("Retired: add a Markdown note instead.")}</p>

      <div style={{ display: "flex", gap: ".5rem" }}>
        <button className="btn" disabled={pending} style={{ padding: ".45rem .9rem" }}>
          {pending ? t("Adding…") : t("Add pages")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: ".45rem .9rem" }}
          onClick={() => setOpen(false)}
        >
          {t("Close")}</button>
      </div>
    </form>
  );
}
