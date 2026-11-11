import { translator } from "@/lib/t";
import { fill, markup } from "@/lib/markup";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { query } from "@/db";
import { currentUser } from "@/lib/session";
import { categoryGroups } from "@/lib/notes";
import { addBoardNote } from "./board-actions";

export const dynamic = "force-dynamic";

const STATE_COLOR: Record<string, string> = {
  pass: "var(--color-riso-green)",
  partial: "var(--color-riso-orange)",
  fail: "var(--color-riso-red)",
  unexamined: "var(--ink-3)",
};

/**
 * The brain as a wall of cards: one column per category, notes as cards, and
 * the exam's failures as EMPTY slots inside the column they belong to. The
 * shape of what is known and what is missing, on one screen — with the pen
 * right there: every column takes a new note without leaving the board.
 */
export default async function BoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await translator();

  const { slug } = await params;
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const { workspaceBrain } = await import("@/lib/svod-access");
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canRead) notFound();
  const brain = access.brain;

  const [groups, notes, gaps] = await Promise.all([
    categoryGroups(brain.id),
    query<{ id: string; title: string; kind: string; category: string | null }>(
      `select id, title, kind, category from notes
        where brain_id = $1 and status = 'active'
        order by created_at desc limit 400`,
      [brain.id],
    ),
    query<{ category: string; question: string }>(
      `select c.category, c.question
         from check_results r join checks c on c.id = r.check_id
        where r.run_id = (
          select id from check_runs where brain_id = $1 and status = 'done'
          order by started_at desc limit 1
        ) and not r.passed
        order by c.category`,
      [brain.id],
    ),
  ]);

  const byCategory = new Map<string, typeof notes>();
  for (const n of notes) {
    const key = n.category ?? "uncategorised";
    byCategory.set(key, [...(byCategory.get(key) ?? []), n]);
  }
  const gapsByCategory = new Map<string, string[]>();
  for (const g of gaps) {
    gapsByCategory.set(g.category, [...(gapsByCategory.get(g.category) ?? []), g.question]);
  }

  // Columns: every category either the notes or the exam knows about — but
  // work first: columns with empty slots lead, then the fullest, and a
  // column with neither cards nor gaps is a label, not a column.
  const columns = [
    ...new Set([
      ...groups.map((g) => g.category),
      ...byCategory.keys(),
      ...gapsByCategory.keys(),
    ]),
  ]
    .filter((c) => (byCategory.get(c)?.length ?? 0) > 0 || (gapsByCategory.get(c)?.length ?? 0) > 0)
    .sort(
      (a, b) =>
        (gapsByCategory.get(b)?.length ?? 0) - (gapsByCategory.get(a)?.length ?? 0) ||
        (byCategory.get(b)?.length ?? 0) - (byCategory.get(a)?.length ?? 0),
    );
  const stateOf = (c: string) => groups.find((g) => g.category === c)?.state ?? "unexamined";

  return (
    <AppShell active="/brains">
      <Link className="eyebrow" href={`/brains/${slug}`}>
        ← {brain.title}
      </Link>
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", flexWrap: "wrap", margin: ".75rem 0 .5rem" }}>
        <h1 className="h1" style={{ margin: 0 }}>
          {t("The board")}</h1>
        <span className="mono" style={{ fontSize: ".8125rem", color: "var(--ink-2)" }}>
          {markup(
            gaps.length === 1
              ? t("<0/> cards · <1/> empty slot the exam wants filled")
              : t("<0/> cards · <1/> empty slots the exam wants filled"),
            [notes.length, gaps.length],
          )}</span>
      </div>
      <p style={{ color: "var(--ink-2)", maxWidth: "62ch", marginTop: 0 }}>
        {t("Every column is a category; red-edged slots are questions the exam failed — write the answer straight into the slot's column and the next sitting measures it.")}</p>

      <div
        style={{
          display: "flex",
          gap: "1rem",
          overflowX: "auto",
          alignItems: "flex-start",
          paddingBottom: "1rem",
          marginTop: "1.5rem",
        }}
      >
        {columns.map((cat) => (
          <section
            key={cat}
            style={{
              minWidth: 260,
              maxWidth: 300,
              flexShrink: 0,
              border: "1.5px solid var(--ink)",
              background: "var(--paper-2)",
            }}
          >
            <header
              style={{
                padding: ".6rem .8rem",
                borderBottom: "1.5px solid var(--ink)",
                display: "flex",
                justifyContent: "space-between",
                gap: ".5rem",
                alignItems: "baseline",
              }}
            >
              <strong style={{ fontSize: ".9375rem", overflowWrap: "anywhere" }}>{cat}</strong>
              <span
                aria-label={fill(t("exam: <0/>"), [stateOf(cat)])}
                style={{
                  width: 10,
                  height: 10,
                  flexShrink: 0,
                  background: STATE_COLOR[stateOf(cat)],
                  border: "1px solid var(--ink)",
                }}
              />
            </header>

            <div style={{ padding: ".6rem", display: "grid", gap: ".5rem" }}>
              {(gapsByCategory.get(cat) ?? []).map((q, i) => (
                <div
                  key={`gap-${i}`}
                  style={{
                    border: "1.5px dashed var(--color-riso-red)",
                    padding: ".5rem .6rem",
                    fontSize: ".8125rem",
                    color: "var(--ink-2)",
                  }}
                >
                  <span className="mono" style={{ fontSize: ".6875rem", color: "var(--color-riso-red)" }}>
                    {t("empty slot — the exam asks:")}</span>
                  <br />
                  {q}
                </div>
              ))}

              {(byCategory.get(cat) ?? []).slice(0, 30).map((n) => (
                <Link
                  key={n.id}
                  href={`/brains/${slug}/notes?q=${encodeURIComponent(n.title.slice(0, 40))}`}
                  style={{
                    border: "1px solid var(--rule)",
                    background: "var(--paper)",
                    padding: ".5rem .6rem",
                    fontSize: ".8125rem",
                    display: "block",
                  }}
                >
                  {n.title}
                  <span className="mono" style={{ display: "block", fontSize: ".625rem", color: "var(--ink-3)" }}>
                    {n.kind}
                  </span>
                </Link>
              ))}
              {(byCategory.get(cat)?.length ?? 0) > 30 && (
                <Link
                  className="mono"
                  style={{ fontSize: ".75rem", textDecoration: "underline" }}
                  href={`/brains/${slug}/notes?category=${encodeURIComponent(cat)}`}
                >
                  {markup(t("all <0/> →"), [
                  byCategory.get(cat)!.length,
                ])}</Link>
              )}

              {access.canEdit && (
              <details>
                <summary className="mono" style={{ fontSize: ".75rem", cursor: "pointer", color: "var(--ink-2)" }}>
                  {t("+ write a card here")}</summary>
                <form action={addBoardNote} style={{ display: "grid", gap: ".4rem", marginTop: ".5rem" }}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="category" value={cat} />
                  <input
                    name="title"
                    required
                    placeholder={t("Searchable title")}
                    style={{ padding: ".45rem .55rem", border: "1.5px solid var(--ink)", background: "var(--paper)", font: "inherit", fontSize: ".8125rem" }}
                  />
                  <textarea
                    name="body"
                    required
                    rows={3}
                    placeholder={t("The fact, in full sentences — searchable the moment you save.")}
                    style={{ padding: ".45rem .55rem", border: "1.5px solid var(--ink)", background: "var(--paper)", font: "inherit", fontSize: ".8125rem" }}
                  />
                  <button className="btn btn-ghost" style={{ padding: ".35rem .7rem", justifySelf: "start", fontSize: ".8125rem" }}>
                    {t("Pin it")}</button>
                </form>
              </details>
              )}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
