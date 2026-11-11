import { translator } from "@/lib/t";
import { fill, markup } from "@/lib/markup";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { Section } from "@/components/ui";
import { query } from "@/db";
import type { Note } from "@/db/types";
import { currentUser } from "@/lib/session";
import {
  categoryGroups,
  duplicatePairs,
  supersededNotes,
  categoryNames,
} from "@/lib/notes";
import { deleteNote, mergeNotes, recategorise, restoreNote } from "./actions";
import ConfirmForm from "@/components/ConfirmForm";
import { isoDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * What is actually in the brain.
 *
 * A flat list answers "what is in here" and nothing else. The questions an
 * owner has are which parts of the goal are covered, whether the same fact is
 * stored four times, and what a note used to say — so coverage comes first,
 * duplicates second, and the notes themselves are grouped rather than piled.
 */

const KIND_TINT: Record<string, string> = {
  fact: "var(--ink-2)",
  rule: "var(--color-riso-blue)",
  layout: "var(--color-riso-violet)",
  example: "var(--color-riso-green)",
  pitfall: "var(--color-riso-red)",
};

const STATE_SIGIL = { pass: "✓", partial: "▲", fail: "✕", unexamined: "·" } as const;

const STATE_COLOUR: Record<string, string> = {
  pass: "var(--color-riso-green)",
  partial: "var(--color-riso-orange)",
  fail: "var(--color-riso-red)",
  unexamined: "var(--ink-3)",
};

export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const t = await translator();

  const { slug } = await params;
  const { q, category } = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  // SVOD: shared policy; readers see active notes only, reviewers also see
  // pending. Unknown and ungranted are the same 404.
  const { workspaceBrain } = await import("@/lib/svod-access");
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canRead) notFound();
  const brain = access.brain;

  const term = q?.trim() ?? "";
  const filtered = Boolean(term || category);

  const [notes, groups, duplicates, history, allCategories] = await Promise.all([
    query<Note & { source_name: string | null }>(
      `select n.*, s.original_name as source_name
         from notes n
         left join sources s on s.id = n.source_id
        where n.brain_id = $1
          and (n.status = 'active' or ($4 and n.status = 'pending'))
          and ($2 = '' or n.title ilike '%' || $2 || '%' or n.body ilike '%' || $2 || '%')
          and ($3::text is null or coalesce(n.category, 'uncategorised') = $3)
        order by coalesce(n.category, 'uncategorised'), n.status desc, n.created_at desc
        limit 400`,
      [brain.id, term, category ?? null, access.canReview],
    ),
    categoryGroups(brain.id),
    // Whole-brain questions, so they are computed only on the unfiltered view —
    // the answer would be confusing sitting next to a search result.
    filtered ? Promise.resolve([]) : duplicatePairs(brain.id),
    filtered ? Promise.resolve([]) : supersededNotes(brain.id),
    categoryNames(brain.id),
  ]);

  // Grouped when browsing, flat when searching: a search result split into
  // category headings hides the thing you were looking for.
  const byCategory = new Map<string, typeof notes>();
  for (const note of notes) {
    const key = note.category ?? "uncategorised";
    byCategory.set(key, [...(byCategory.get(key) ?? []), note]);
  }

  return (
    <AppShell active="/brains">
      <Link className="eyebrow" href={`/brains/${brain.slug}`}>
        ← {brain.title}
      </Link>

      <div className="app-head" style={{ marginTop: ".5rem" }}>
        <h1 className="h1">{t("Inside this brain")}</h1>
        <span className="eyebrow">
          {markup(t("<0/> active <1/>"), [
          brain.note_count,
          history.length > 0 && ` · ${history.length} replaced`,
        ])}</span>
      </div>

      <div className="stack">
        <Section title={t("Coverage")} aside={t("what the exam asks vs what you hold")}>
          <p className="lede" style={{ marginBottom: ".75rem" }}>
            {t("A category the exam asks about with no notes behind it is the most useful row here — it names the material to add next. Click one to see only its notes.")}</p>

          <div className="rows">
            {groups.length === 0 ? (
              <p className="row-empty">
                {markup(t("Nothing yet. Upload sources on the <0>brain page</0> ."), [
                <Link href={`/brains/${brain.slug}`} style={{ textDecoration: "underline" }} key="s0" />,
              ])}</p>
            ) : (
              groups.map((g) => (
                <Link
                  key={g.category}
                  className="row"
                  href={
                    category === g.category
                      ? `/brains/${brain.slug}/notes`
                      : `/brains/${brain.slug}/notes?category=${encodeURIComponent(g.category)}`
                  }
                  data-tint={
                    g.state === "fail" ? "red" : g.state === "partial" ? "orange" : undefined
                  }
                  style={category === g.category ? { background: "var(--paper)" } : undefined}
                >
                  <span style={{ minWidth: 0 }}>
                    <strong>
                      <span
                        className="mono"
                        style={{ color: STATE_COLOUR[g.state], marginRight: ".5rem" }}
                      >
                        {STATE_SIGIL[g.state]}
                      </span>
                      {g.category}
                    </strong>
                    <span className="row-meta">
                      {g.notes === 0
                        ? t("no notes cover this")
                        : fill(g.notes === 1 ? t("<0/> note") : t("<0/> notes"), [g.notes])}
                      {g.total !== null &&
                        fill(t(" · exam <0/> of <1/>"), [g.passed ?? 0, g.total])}
                      {g.total === null && g.notes > 0 && t(" · not on the exam")}
                    </span>
                  </span>
                  <span className="row-side">
                    {g.total !== null
                      ? `${Math.round(((g.passed ?? 0) / g.total) * 100)}%`
                      : "—"}
                  </span>
                </Link>
              ))
            )}
          </div>
        </Section>

        {access.canEdit && duplicates.length > 0 && (
          <Section
            title={t("Saying the same thing twice")}
            aside={fill(
              duplicates.length === 1 ? t("<0/> pair") : t("<0/> pairs"),
              [duplicates.length],
            )}
          >
            <p className="lede" style={{ marginBottom: ".75rem" }}>
              {t("Two notes this close crowd each other out of search results and make the brain look fuller than it is. Keep the one that says it better — the other is superseded, not deleted, and stays in the history below.")}</p>

            <div className="stack-tight">
              {duplicates.map((pair) => (
                <div key={`${pair.a.id}-${pair.b.id}`} className="panel">
                  <p className="eyebrow" style={{ margin: "0 0 .6rem" }}>
                    {markup(t("<0/>% alike"), [
                    Math.round((1 - pair.distance) * 100),
                  ])}</p>
                  <div
                    style={{
                      display: "grid",
                      gap: "1rem",
                      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                    }}
                  >
                    {[pair.a, pair.b].map((note, i) => {
                      const other = i === 0 ? pair.b : pair.a;
                      return (
                        <div key={note.id}>
                          <strong>{note.title}</strong>
                          <p
                            style={{
                              color: "var(--ink-2)",
                              fontSize: ".9375rem",
                              margin: ".3rem 0 .5rem",
                            }}
                          >
                            {note.body}
                          </p>
                          <span className="row-meta" style={{ marginBottom: ".6rem" }}>
                            {markup(t("<0/> · added <1/>"), [
                            note.category ?? "uncategorised",
                            isoDate(note.created_at),
                          ])}</span>
                          <form action={mergeNotes}>
                            <input type="hidden" name="keep" value={note.id} />
                            <input type="hidden" name="drop" value={other.id} />
                            <button className="btn btn-ghost" style={{ fontSize: ".8125rem" }}>
                              {t("Keep this one")}</button>
                          </form>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section
          title={category ? fill(t("Notes in <0/>"), [category]) : term ? "Search results" : "Every note"}
          aside={`${notes.length}${notes.length === 400 ? "+" : ""} shown`}
        >
          <form style={{ display: "flex", gap: ".6rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            <input
              name="q"
              defaultValue={term}
              placeholder={t("Search titles and bodies")}
              style={{
                flex: 1,
                minWidth: 240,
                padding: ".7rem .85rem",
                border: "1.5px solid var(--ink)",
                background: "var(--paper-2)",
                font: "inherit",
              }}
            />
            {category && <input type="hidden" name="category" value={category} />}
            <button className="btn">{t("Search")}</button>
            {filtered && (
              <Link className="btn btn-ghost" href={`/brains/${brain.slug}/notes`}>
                {t("Clear")}</Link>
            )}
          </form>

          {notes.length === 0 ? (
            <div className="rows">
              <p className="row-empty">
                {filtered
                  ? t("Nothing matches that.")
                  : t("This brain has no notes yet. Upload sources on the brain page.")}
              </p>
            </div>
          ) : term ? (
            <div className="rows">
              {notes.map((note) => (
                <NoteRow
                  key={note.id}
                  t={t}
                  note={note}
                  slug={brain.slug}
                  categories={allCategories}
                />
              ))}
            </div>
          ) : (
            <div className="stack-tight">
              {[...byCategory.entries()].map(([name, list]) => (
                <div key={name}>
                  <p className="eyebrow" style={{ marginBottom: ".4rem" }}>
                    {name} · {list.length}
                  </p>
                  <div className="rows">
                    {list.map((note) => (
                      <NoteRow
                        t={t}
                        key={note.id}
                        note={note}
                        slug={brain.slug}
                        categories={allCategories}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {access.canEdit && history.length > 0 && (
          <Section title={t("What it used to say")} aside={`${history.length} replaced`}>
            <details>
              <summary
                className="mono"
                style={{ cursor: "pointer", fontSize: ".8125rem", color: "var(--ink-2)" }}
              >
                {t("Show replaced notes")}</summary>
              <div className="rows" style={{ marginTop: ".75rem" }}>
                {history.map((h) => (
                  <div key={h.id} className="row">
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ textDecoration: "line-through", opacity: 0.7 }}>
                        {h.title}
                      </strong>
                      <span className="row-sub">{h.body}</span>
                      <span className="row-meta">
                        {h.at} · {h.reason}
                        {h.replaced_by_title && ` → ${h.replaced_by_title}`}
                      </span>
                    </span>
                    <form action={restoreNote}>
                      <input type="hidden" name="id" value={h.id} />
                      <button className="linkish">{t("bring back")}</button>
                    </form>
                  </div>
                ))}
              </div>
            </details>
          </Section>
        )}
      </div>
    </AppShell>
  );
}

function NoteRow({
  t,
  note,
  slug,
  categories,
}: {
  t: (english: string) => string;
  note: Note & { source_name: string | null };
  slug: string;
  categories: string[];
}) {
  return (
    <article className="row" style={{ opacity: note.status === "pending" ? 0.72 : 1 }}>
      <span style={{ minWidth: 0 }}>
        <strong>{note.title}</strong>
        <span className="row-sub">{note.body}</span>
        <span
          className="row-meta"
          style={{ display: "flex", gap: ".9rem", flexWrap: "wrap", alignItems: "center" }}
        >
          <span style={{ color: KIND_TINT[note.kind] ?? "var(--ink-3)" }}>{note.kind}</span>
          <span>
            {note.author === "agent"
              ? fill(t("written by <0/>"), [note.agent_client ?? t("an agent")])
              : note.author === "human"
                ? t("added by hand")
                : fill(t("from <0/>"), [note.source_name ?? t("a source")])}
          </span>
          {note.status === "pending" && (
            <span style={{ color: "var(--color-riso-orange)" }}>
              {t("awaiting review — not searchable")}
            </span>
          )}

          {/* Recategorising is the fix for extraction inventing a synonym, so it
              belongs on the note rather than three screens away. */}
          <form action={recategorise} style={{ display: "flex", gap: ".3rem" }}>
            <input type="hidden" name="id" value={note.id} />
            <select name="category" defaultValue={note.category ?? ""} className="row-select">
              <option value="">{t("uncategorised")}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {note.category && !categories.includes(note.category) && (
                <option value={note.category}>{note.category}</option>
              )}
            </select>
            <button className="linkish">{t("move")}</button>
          </form>

          <ConfirmForm
            action={deleteNote}
            message={fill(t("Delete “<0/>”? This cannot be undone."), [note.title])}
            style={{ marginLeft: "auto" }}
          >
            <input type="hidden" name="id" value={note.id} />
            <input type="hidden" name="slug" value={slug} />
            <button className="linkish" data-danger="true">
              {t("delete")}
            </button>
          </ConfirmForm>
        </span>
      </span>
    </article>
  );
}
