import { translator } from "@/lib/t";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import AppShell from "@/components/AppShell";
import ProfileForm from "./ProfileForm";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("Account — svod") };
}

/** SVOD stage 7: profile + tokens only. No plans, balance or model keys. */
export default async function SettingsPage() {
  const t = await translator();

  const user = await currentUser();
  if (!user) redirect("/sign-in?next=/settings");

  return (
    <AppShell active="/settings" eyebrow={user.email} title={t("Profile")}>
      <section>
        <h2 className="h2" style={{ marginBottom: ".75rem" }}>
          {t("Profile")}</h2>
        <ProfileForm name={user.name ?? ""} handle={user.handle ?? ""} />
      </section>

      <section style={{ marginTop: "2.5rem" }}>
        <h2 className="h2" style={{ marginBottom: ".5rem" }}>
          {t("Connecting an agent")}</h2>
        <p style={{ color: "var(--ink-2)", marginTop: 0, maxWidth: "60ch" }}>
          {t("One token works across every base you can reach. The setup lines for supported clients are on the connect page.")}</p>
        <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
          <Link className="btn" href="/settings/tokens">
            {t("Your tokens")}</Link>
          <Link className="btn btn-ghost" href="/connect">
            {t("How to connect")}</Link>
        </div>
      </section>
    </AppShell>
  );
}
