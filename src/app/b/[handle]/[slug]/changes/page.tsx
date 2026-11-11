import { markup } from "@/lib/markup";
import Link from "next/link";
import { translator } from "@/lib/t";
import { notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import Contents from "@/components/Contents";
import SiteFooter from "@/components/SiteFooter";
import { query } from "@/db";
import { accessForSlug } from "@/lib/access";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}) {
  // SVOD: no public metadata. Granted readers see the page; everyone else
  // learns nothing from headers or indexes.
  await params;
  return { title: "svod", robots: { index: false, follow: false } };
}

/**
 * The diff feed: changelogs everyone writes; VERIFIED deltas nobody does.
 * Every entry here is a fact from the machinery — a source whose content
 * hash moved, a sitting whose score is signed by the judge — so "what
 * changed this month" is an answer, not an assertion.
 */
export default async function ChangesPage({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}) {
  const t = await translator();

  const { handle, slug } = await params;
  const user = await currentUser();
  const found = await accessForSlug(handle, slug, user?.id ?? null);
  if (!found || (!found.access && !found.preview)) notFound();
  const { brain } = found;

  // Sittings, each diffed against the one before it — the number and what
  // moved underneath it.
  const runs = await query<{
    id: string;
    score: number | null;
    at: string;
    gained: number;
    lost: number;
  }>(
    `with ordered as (
       select id, score, started_at,
              lag(id) over (order by started_at) as prev_id
         from check_runs
        where brain_id = $1 and status = 'done' and kind = 'full'
        order by started_at desc limit 12)
     select o.id, o.score,
            to_char(o.started_at at time zone 'UTC', 'YYYY-MM-DD') as at,
            coalesce((select count(*)::int from check_results cur
               join check_results prev on prev.check_id = cur.check_id and prev.run_id = o.prev_id
              where cur.run_id = o.id and cur.passed and not prev.passed), 0) as gained,
            coalesce((select count(*)::int from check_results cur
               join check_results prev on prev.check_id = cur.check_id and prev.run_id = o.prev_id
              where cur.run_id = o.id and not cur.passed and prev.passed), 0) as lost
       from ordered o
      order by o.started_at desc`,
    [brain.id],
  );

  const sources = await query<{ name: string; at: string }>(
    `select coalesce(original_name, url, kind) as name,
            to_char(changed_at at time zone 'UTC', 'YYYY-MM-DD') as at
       from sources
      where brain_id = $1 and changed_at is not null
      order by changed_at desc limit 20`,
    [brain.id],
  );

  return (
    <>
      <TopBar />
      <Contents active="/explore" />
      <main className="shell" style={{ paddingBlock: "clamp(2rem, 5vw, 3.5rem)" }}>
        <p className="eyebrow">
          <Link href={`/b/${handle}/${slug}`}>← {brain.title}</Link>
        </p>
        <h1 className="display" style={{ fontSize: "clamp(1.8rem, 5vw, 3rem)", margin: ".5rem 0 1rem" }}>
          {t("What changed, verified.")}</h1>
        <p className="lede" style={{ maxWidth: "58ch" }}>
          {t("Changelogs are claims; this is receipts. Every source re-read when its content actually moved, every exam re-sat after — the deltas below are signed by the grader, not written by anyone.")}</p>

        <section style={{ marginTop: "2.5rem" }}>
          <div className="section-head">
            <h2 className="h2">{t("Exam sittings")}</h2>
            <span className="eyebrow">{t("each diffed against the one before")}</span>
          </div>
          {runs.length === 0 ? (
            <p className="lede">{t("No completed sittings yet.")}</p>
          ) : (
            <div className="rows" style={{ maxWidth: "48rem" }}>
              {runs.map((r) => (
                <div key={r.id} className="row">
                  <span style={{ minWidth: 0 }}>
                    <strong className="mono">{r.at}</strong>
                    <span className="row-sub">
                      {r.gained > 0 && (
                        <span style={{ color: "var(--color-riso-green)" }}>
                          {markup(t("+<0/> newly passed"), [
                          r.gained,
                        ])}</span>
                      )}
                      {r.gained > 0 && r.lost > 0 && " · "}
                      {r.lost > 0 && (
                        <span style={{ color: "var(--color-riso-red)" }}>{markup(t("−<0/> lost"), [
                          r.lost,
                        ])}</span>
                      )}
                      {r.gained === 0 && r.lost === 0 && t("held steady")}
                    </span>
                  </span>
                  <span className="row-side mono">{r.score === null ? "—" : `${r.score}%`}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={{ marginTop: "2.5rem" }}>
          <div className="section-head">
            <h2 className="h2">{t("Sources whose content moved")}</h2>
            <span className="eyebrow">{t("hash-detected, then re-read")}</span>
          </div>
          {sources.length === 0 ? (
            <p className="lede">{t("No detected content changes yet — the sources are as they were ingested.")}</p>
          ) : (
            <div className="rows" style={{ maxWidth: "48rem" }}>
              {sources.map((s, i) => (
                <div key={i} className="row">
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ overflowWrap: "anywhere" }}>{s.name}</strong>
                  </span>
                  <span className="row-side mono">{s.at}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
