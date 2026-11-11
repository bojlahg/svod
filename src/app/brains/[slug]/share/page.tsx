import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { translator } from "@/lib/t";
import { markup } from "@/lib/markup";
import AppShell from "@/components/AppShell";
import DeleteBrain from "./DeleteBrain";
import RemoveMember from "./RemoveMember";
import { query } from "@/db";
import { currentUser } from "@/lib/session";
import { workspaceBrain } from "@/lib/svod-access";

/**
 * SVOD stage 2 base administration: owner/operator only.
 *
 * Legacy sharing (email grants, gift links, public visibility, purchases) is
 * retired — access is brain_members + owner + env operator. Role grants live
 * in /admin/users (operator); this page lists members, offers export (role
 * only, no plan gate) and deletion.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const t = await translator();

  const access = await workspaceBrain(slug, user.id);
  if (!access?.canAdmin) notFound();
  const brain = access.brain;

  const members = await query<{
    user_id: string;
    email: string;
    handle: string | null;
    role: string;
  }>(
    `select m.user_id, u.email, u.handle, m.role
       from brain_members m join "user" u on u.id = m.user_id
      where m.brain_id = $1
      order by m.granted_at`,
    [brain.id],
  );

  return (
    <AppShell active="/brains" narrow>
      <Link className="eyebrow" href={`/brains/${slug}`}>
        ← {brain.title}
      </Link>

      <h1 className="h1" style={{ margin: ".75rem 0 .5rem" }}>{t("Manage base")}</h1>
      <p style={{ color: "var(--ink-2)", marginTop: 0, maxWidth: "58ch" }}>
        {markup(t("Private by default. Access is granted per base in <0>People (operator)</0>. Owners and reviewers listed below can be removed here."), [
          <Link href="/admin/users" style={{ textDecoration: "underline" }} key="s0" />,
        ])}
      </p>

      <section style={{ marginTop: "1.75rem" }}>
        <h2 className="h2" style={{ marginBottom: ".5rem" }}>{t("Members")}</h2>
        {members.length === 0 ? (
          <p style={{ color: "var(--ink-2)" }}>{t("Only you — no grants on this base.")}</p>
        ) : (
          <div className="rows">
            {members.map((m) => (
              <div key={m.user_id} className="row">
                <span style={{ minWidth: 0 }}>
                  <strong>{m.handle ?? m.email}</strong>
                  <span className="row-meta">{m.email} · {m.role}</span>
                </span>
                <RemoveMember brainId={brain.id} userId={m.user_id} slug={slug} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 className="h2" style={{ marginBottom: ".5rem" }}>{t("Export")}</h2>
        <p style={{ color: "var(--ink-2)", marginTop: 0, maxWidth: "58ch" }}>
          {t("Active notes as Markdown. Gated by role only.")}
        </p>
        <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
          {[
            ["claude", t("CLAUDE.md")],
            ["skill", t("Claude Skill")],
            ["agents", t("AGENTS.md")],
          ].map(([format, label]) => (
            <a
              key={format}
              className="btn btn-ghost"
              href={`/api/brains/${brain.id}/export?format=${format}`}
            >
              {label}
            </a>
          ))}
        </div>
      </section>

      <hr className="rule" style={{ margin: "3rem 0 0" }} />
      <DeleteBrain slug={slug} title={brain.title} noteCount={brain.note_count} />
    </AppShell>
  );
}
