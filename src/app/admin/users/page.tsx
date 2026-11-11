import { translator } from "@/lib/t";
import AppShell from "@/components/AppShell";
import { requireAdmin } from "@/lib/admin";
import { query } from "@/db";
import { env } from "@/lib/env";
import {
  CreateUserForm,
  EditUserForm,
  RemoveRoleForm,
  ResetPasswordForm,
  RoleForm,
} from "./Forms";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("People — admin"), robots: { index: false, follow: false } };
}

interface SvodUser {
  id: string;
  email: string;
  name: string | null;
  handle: string | null;
  email_verified: boolean;
  created_at: string;
  owned: number;
  memberships: number;
}

interface BrainRow {
  id: string;
  title: string;
  slug: string;
  owner_email: string;
  owner_handle: string | null;
}

interface Membership {
  user_id: string;
  brain_id: string;
  role: string;
  brain_title: string;
  brain_slug: string;
  owner_handle: string | null;
}

export default async function AdminUsersPage() {
  const t = await translator();
  await requireAdmin();

  // No arbitrary row cap: every account and every base is listed so no
  // grant target hides past an offset. Self-hosted scale keeps this cheap.
  const users = await query<SvodUser>(
    `select u.id, u.email, u.name, u.handle, u."emailVerified" as email_verified,
            to_char(u."createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            (select count(*)::int from brains b where b.owner_id = u.id) as owned,
            (select count(*)::int from brain_members m where m.user_id = u.id) as memberships
       from "user" u
      order by u."createdAt" desc`,
  );
  const brains = await query<BrainRow>(
    `select b.id, b.title, b.slug, u.email as owner_email, u.handle as owner_handle
       from brains b join "user" u on u.id = b.owner_id
      order by b.updated_at desc`,
  );
  const memberships = await query<Membership>(
    `select m.user_id, m.brain_id, m.role, b.title as brain_title, b.slug as brain_slug,
            u.handle as owner_handle
       from brain_members m
       join brains b on b.id = m.brain_id
       join "user" u on u.id = b.owner_id`,
  );
  const byUser = new Map<string, Membership[]>();
  for (const m of memberships) {
    byUser.set(m.user_id, [...(byUser.get(m.user_id) ?? []), m]);
  }

  const boot = (env.MOZG_ADMIN_EMAIL ?? "").trim().toLowerCase();

  return (
    <AppShell active="/admin/users" eyebrow={t("Operator")} title={t("People")}>
      <p className="lede">
        {t(
          "Operator-created verified accounts only — no public sign-up, no email round-trip. The .env bootstrap administrator is managed outside this UI and cannot be edited or reset here. Accounts are never deleted from this screen.",
        )}
      </p>

      <section className="panel" style={{ marginTop: "1rem", padding: "1rem 1.25rem" }}>
        <h2 className="h2" style={{ margin: "0 0 .75rem" }}>{t("Create account")}</h2>
        <CreateUserForm />
      </section>

      <div className="adm-scroll" style={{ marginTop: "1rem" }}>
        <table className="adm">
          <thead>
            <tr>
              <th>{t("Account")}</th>
              <th>{t("Bases")}</th>
              <th>{t("Edit")}</th>
              <th>{t("Password")}</th>
              <th>{t("Role per base")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isBoot = boot && u.email.trim().toLowerCase() === boot;
              const grants = byUser.get(u.id) ?? [];
              return (
                <tr key={u.id}>
                  <td>
                    <strong>{u.handle ?? u.email.split("@")[0]}</strong>
                    <span style={{ display: "block", color: "var(--ink-2)", fontSize: ".75rem" }}>
                      {u.email}
                      {!u.email_verified && ` · ${t("unverified")}`}
                      {isBoot && ` · ${t(".env bootstrap")}`}
                    </span>
                    <span className="mono" style={{ display: "block", fontSize: ".6875rem", color: "var(--ink-3)" }}>
                      {u.created_at.slice(0, 10)}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: ".75rem" }}>
                    {t("owns")} {u.owned} · {t("member")} {u.memberships}
                    {grants.length > 0 && (
                      <span style={{ display: "block", marginTop: ".35rem" }}>
                        {grants.map((g) => (
                          <span key={g.brain_id} style={{ display: "flex", gap: ".35rem", alignItems: "center", marginBottom: ".2rem" }}>
                            <span>
                              {g.owner_handle ? `${g.owner_handle}/` : ""}{g.brain_slug} · {g.role}
                            </span>
                            {!isBoot && (
                              <RemoveRoleForm userId={u.id} brainId={g.brain_id} label={t("remove")} />
                            )}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    {isBoot ? (
                      <span className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)" }}>
                        {t("managed by .env")}
                      </span>
                    ) : (
                      <EditUserForm id={u.id} name={u.name} email={u.email} />
                    )}
                  </td>
                  <td>
                    {isBoot ? (
                      <span className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)" }}>
                        {t("rotate via .env")}
                      </span>
                    ) : (
                      <ResetPasswordForm id={u.id} />
                    )}
                  </td>
                  <td>
                    {isBoot ? (
                      <span className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)" }}>
                        {t("operator: all bases")}
                      </span>
                    ) : (
                      <RoleForm
                        userId={u.id}
                        brains={brains}
                        label={{
                          base: t("base…"),
                          reader: t("reader"),
                          editor: t("editor"),
                          reviewer: t("reviewer"),
                          grant: t("Grant"),
                        }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)", marginTop: "1rem" }}>
        {t("Roles: reader sees active notes; editor also edits; reviewer also approves pending. Owner and operator administer every base.")}
      </p>
    </AppShell>
  );
}
