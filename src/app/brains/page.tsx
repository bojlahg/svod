import { translator } from "@/lib/t";
import { fill } from "@/lib/markup";
import Link from "next/link";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { currentUser } from "@/lib/session";
import { listAccessibleBrains } from "@/lib/svod-access";
import { categoryScores, tintFor } from "@/lib/brains";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("Workspace — svod") };
}

export default async function BrainsPage() {
  const t = await translator();
  const user = await currentUser();
  if (!user) redirect("/sign-in?next=/brains");

  // One shared policy, one ordering: owned + explicitly granted; the operator
  // sees every base. No plan, billing or catalogue gates on this list.
  // An empty workspace renders inline below — no redirect to any onboarding
  // route (retired in the private fork).
  const bases = await listAccessibleBrains(user.id);

  const scores = await categoryScores(bases.map((b) => b.id));
  if (!bases.length) {
    return (
      <AppShell active="/brains" eyebrow={t("Workspace")} title={t("Your bases")} narrow>
        <p className="lede">
          {t("No bases yet. Create a private base — only you can see it until you grant someone access.")}
        </p>
        <div style={{ display: "flex", gap: ".75rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <Link className="btn" href="/brains/new">{t("New base")}</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      active="/brains"
      eyebrow={t("Workspace")}
      title={t("Bases")}
      action={<Link className="btn" href="/brains/new">{t("New base")}</Link>}
    >
      <div className="stack">
        <p className="lede">
          {t("Every base you own or were granted access to. A base is addressed by its ID or by owner handle + slug — slugs alone are not unique across owners.")}
        </p>
        <div className="grid-brains">
          {bases.map((b) => {
            const cats = scores.get(b.id) ?? [];
            return (
              <Link key={b.id} href={`/brains/${b.id}`} className="card" data-tint={tintFor(b)}>
                <span className="eyebrow" style={{ color: "inherit", opacity: 0.75 }}>
                  {b.owner_handle ?? ""} · {b.member_role} · {fill(t("<0/> notes"), [b.note_count])}
                </span>
                <h2 className="card-title">{b.title}</h2>
                <p className="card-goal">{b.goal ?? t("No goal set yet.")}</p>
                <div className="readout" role="img" aria-label={cats.map((c) => `${c.category}: ${c.passed}/${c.total}`).join(", ") || "Not examined yet"}>
                  {(cats.length ? cats : Array.from({ length: 6 }, () => ({ state: "empty" as const }))).map((c, i) => (
                    <span key={i} className="readout-cell" data-state={c.state} />
                  ))}
                </div>
                <div className="card-foot">
                  <span className="mono" style={{ fontSize: ".75rem", opacity: 0.8 }}>
                    {b.owner_handle ? `${b.owner_handle}/${b.slug}` : b.slug}
                  </span>
                  {b.score !== null ? (
                    <span className="card-score">{b.score}<sup>%</sup></span>
                  ) : (
                    <span style={{ opacity: 0.8 }}>{t("not examined")}</span>
                  )}
                </div>
              </Link>
            );
          })}
          <Link href="/brains/new" className="card-new">
            <span className="plus">+</span>
            <span className="mono" style={{ fontSize: ".8125rem" }}>{t("New base")}</span>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
