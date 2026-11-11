import { translator } from "@/lib/t";
import { fill, markup } from "@/lib/markup";
import Link from "next/link";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { Section, Rows, Row } from "@/components/ui";
import TokenForm from "./TokenForm";
import TokenScopesForm from "./TokenScopesForm";
import IchiTokenForm from "./IchiTokenForm";
import { query } from "@/db";
import type { McpToken, McpTokenScope } from "@/db/types";
import { currentUser } from "@/lib/session";
import { quotaRemaining } from "@/lib/tokens";
import { listIchiTokens } from "@/lib/ichi-tokens";
import { revoke, revokeIchi } from "./actions";
import ConfirmForm from "@/components/ConfirmForm";
import { listAccessibleBrains, isOperatorEmail } from "@/lib/svod-access";
import { grantableCapabilities } from "@/lib/svod-token-scopes";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("Tokens — mozg") };
}

type Tab = "mozg" | "ichi";

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const t = await translator();

  const user = await currentUser();
  if (!user) redirect("/sign-in?next=/settings/tokens");

  const { t: tabParam } = await searchParams;
  const tab: Tab = tabParam === "ichi" ? "ichi" : "mozg";

  const [tokens, remaining, used, ichiTokens] = await Promise.all([
    query<McpToken>(
      `select * from mcp_tokens where user_id = $1 and revoked_at is null
        order by created_at desc`,
      [user.id],
    ),
    quotaRemaining(user.id, user.plan),
    query<{ n: number }>(
      `select count(*)::int as n from calls
        where caller_id = $1 and created_at >= date_trunc('month', now())`,
      [user.id],
    ).then((r) => r[0]?.n ?? 0),
    listIchiTokens(user.id),
  ]);

  const tabStyle = (on: boolean) => ({
    padding: ".55rem .95rem",
    border: "1.5px solid var(--ink)",
    background: on ? "var(--ink)" : "transparent",
    color: on ? "var(--paper-2)" : "var(--ink)",
    textDecoration: "none",
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
    fontSize: ".8125rem",
  });

  // Scoped creation options: admin may grant any base; ordinary issuers only
  // their current membership with allowed capabilities.
  let scopeBases: { id: string; title: string; slug: string; project_id: string | null; allowed: ("read" | "propose" | "write")[] }[] = [];
  let scopesByToken = new Map<string, McpTokenScope[]>();
  if (tab === "mozg") {
    const op = isOperatorEmail(user.email);
    const accessible = await listAccessibleBrains(user.id);
    let all: typeof accessible = accessible;
    if (op) {
      all = await query<(typeof accessible)[number]>(
        `select b.*, u.handle as owner_handle,
                case when b.owner_id = $1 then 'owner' else coalesce(m.role, 'owner') end as member_role
           from brains b join "user" u on u.id = b.owner_id
           left join brain_members m on m.brain_id = b.id and m.user_id = $1
          order by b.updated_at desc`,
        [user.id],
      );
    }
    scopeBases = [];
    for (const b of all) {
      const g = await grantableCapabilities(b.id, user.id);
      if (!g.ok || !g.allowed.length) continue;
      scopeBases.push({ id: b.id, title: b.title, slug: b.slug, project_id: (b as { project_id?: string | null }).project_id ?? null, allowed: g.allowed });
    }
    if (tokens.length) {
      const rows = await query<McpTokenScope>(
        `select * from mcp_token_scopes where token_id = any($1::uuid[])`,
        [tokens.map((x) => x.id)],
      );
      scopesByToken = new Map();
      for (const r of rows) scopesByToken.set(r.token_id, [...(scopesByToken.get(r.token_id) ?? []), r]);
    }
  }

  return (
    <AppShell
      active="/settings/tokens"
      eyebrow={fill(t("<0/> calls this month · <1/> left on <2/>"), [used, remaining, user.plan])}
      title={t("Access tokens")}
      narrow
    >
      <div className="stack">
        <nav style={{ display: "flex", gap: ".5rem" }} aria-label={t("Which product")}>
          <Link href="/settings/tokens" style={tabStyle(tab === "mozg")}>
            {markup(t("mozg<0/>"), [
            tokens.length ? ` · ${tokens.length}` : "",
          ])}</Link>
          <Link href="/settings/tokens?t=ichi" style={tabStyle(tab === "ichi")}>
            {markup(t("ichi<0/>"), [
            ichiTokens.length ? ` · ${ichiTokens.length}` : "",
          ])}</Link>
        </nav>

        {tab === "mozg" ? (
          <>
            <div>
              <p className="lede">
                {markup(t("One token per machine, scoped to chosen bases: read, read+propose, and for project bases read+direct-write. Default deny — unscoped tokens and OAuth stay denied until granted. Revoking takes effect on the next call. <0>Usage</0> shows where the calls went."), [
                <Link href="/settings/usage" key="s0" />,
              ])}</p>
              <TokenForm bases={scopeBases} />
            </div>

            {tokens.length > 0 && (
              <Section title={t("Live tokens")} aside={fill(t("<0/> active"), [tokens.length])}>
                <Rows>
                  {tokens.map((token) => (
                    <Row
                      key={token.id}
                      title={`${token.prefix}…`}
                      sub={token.name ?? undefined}
                      meta={
                        token.last_used_at
                          ? fill(t("last used <0/>"), [
                              new Date(token.last_used_at).toISOString().slice(0, 10),
                            ])
                          : t("never used")
                      }
                      side={
                        <ConfirmForm
                          action={revoke}
                          message={fill(
                            t("Revoke <0/>…? Any client using it loses access on the next call."),
                            [token.prefix],
                          )}
                        >
                          <input type="hidden" name="id" value={token.id} />
                          <button className="mono" style={revokeStyle}>
                            {t("revoke")}</button>
                        </ConfirmForm>
                      }
                    />
                  ))}
                </Rows>
                <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
                  {tokens.map((token) => (
                    <TokenScopesForm
                      key={token.id}
                      token={token}
                      bases={scopeBases}
                      scopes={scopesByToken.get(token.id) ?? []}
                    />
                  ))}
                </div>
                <p className="mono" style={{ fontSize: ".6875rem", color: "var(--ink-2)" }}>
                  {t("Secrets show once at creation and are never stored in plaintext.")}
                </p>
              </Section>
            )}
          </>
        ) : (
          <>
            <div>
              <p className="lede">
                {markup(t("One token per machine, for <0>ichi</0> — the sibling that gives your agent a persistent character and holds the standards you lay down. Same account as this one. Issued here and nowhere else, so every credential you own is on one page."), [
                <a href="https://ichi.mozg.sh" target="_blank" rel="noreferrer" key="s0" />,
              ])}</p>
              <IchiTokenForm />
            </div>

            {ichiTokens.length > 0 && (
              <Section title={t("Live ichi tokens")} aside={fill(t("<0/> active"), [ichiTokens.length])}>
                <Rows>
                  {ichiTokens.map((token) => (
                    <Row
                      key={token.id}
                      title={`${token.prefix}…`}
                      sub={token.name ?? undefined}
                      meta={
                        token.last_used_at
                          ? fill(t("last used <0/>"), [
                              new Date(token.last_used_at).toISOString().slice(0, 10),
                            ])
                          : t("never used")
                      }
                      side={
                        <ConfirmForm
                          action={revokeIchi}
                          message={fill(
                            t("Revoke <0/>…? Any agent using it stops reaching ichi on the next call."),
                            [token.prefix],
                          )}
                        >
                          <input type="hidden" name="id" value={token.id} />
                          <button className="mono" style={revokeStyle}>
                            {t("revoke")}</button>
                        </ConfirmForm>
                      }
                    />
                  ))}
                </Rows>
              </Section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

const revokeStyle = {
  background: "none",
  border: 0,
  padding: 0,
  color: "var(--color-riso-red)",
  fontSize: ".8125rem",
  cursor: "pointer",
  textDecoration: "underline",
} as const;
