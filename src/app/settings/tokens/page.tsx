import { translator } from "@/lib/t";
import { fill } from "@/lib/markup";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { Section, Rows, Row } from "@/components/ui";
import TokenForm from "./TokenForm";
import TokenScopesForm from "./TokenScopesForm";
import { query } from "@/db";
import type { McpToken, McpTokenScope } from "@/db/types";
import { currentUser } from "@/lib/session";
import { revoke } from "./actions";
import ConfirmForm from "@/components/ConfirmForm";
import { listAccessibleBrains, isOperatorEmail } from "@/lib/svod-access";
import { grantableCapabilities } from "@/lib/svod-token-scopes";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("Tokens — svod") };
}

export default async function TokensPage() {
  const t = await translator();

  const user = await currentUser();
  if (!user) redirect("/sign-in?next=/settings/tokens");

  const [tokens] = await Promise.all([
    query<McpToken>(
      `select * from mcp_tokens where user_id = $1 and revoked_at is null
        order by created_at desc`,
      [user.id],
    ),
  ]);

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
  const scopeBases: { id: string; title: string; slug: string; project_id: string | null; allowed: ("read" | "propose" | "write")[] }[] = [];
  for (const b of all) {
    const g = await grantableCapabilities(b.id, user.id);
    if (!g.ok || !g.allowed.length) continue;
    scopeBases.push({ id: b.id, title: b.title, slug: b.slug, project_id: (b as { project_id?: string | null }).project_id ?? null, allowed: g.allowed });
  }
  let scopesByToken = new Map<string, McpTokenScope[]>();
  if (tokens.length) {
    const rows = await query<McpTokenScope>(
      `select * from mcp_token_scopes where token_id = any($1::uuid[])`,
      [tokens.map((x) => x.id)],
    );
    scopesByToken = new Map();
    for (const r of rows) scopesByToken.set(r.token_id, [...(scopesByToken.get(r.token_id) ?? []), r]);
  }

  return (
    <AppShell
      active="/settings/tokens"
      title={t("Access tokens")}
      narrow
    >
      <div className="stack">
        <div>
          <p className="lede">
            {t("One token per machine, scoped to chosen bases: read, read+propose, and for project bases read+direct-write. Default deny — unscoped tokens stay denied until granted. Revoking takes effect on the next call.")}
          </p>
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
