import Link from "next/link";
import { translator } from "@/lib/t";
import TopBar from "@/components/TopBar";
import SiteFooter from "@/components/SiteFooter";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = await translator();
  return { title: t("Retired — svod"), robots: { index: false, follow: false } };
}

/**
 * SVOD stage 2: gift links are retired. No lookup by code (that would reveal
 * whether a code exists), no grants written. Access is per-base roles in
 * /admin/users.
 */
export default async function GiftPage() {
  const t = await translator();
  return (
    <>
      <TopBar />
      <main className="shell" style={{ paddingBlock: "clamp(3rem, 9vw, 6rem)", maxWidth: 720 }}>
        <p className="eyebrow">{t("Retired")}</p>
        <h1 className="h1" style={{ margin: ".5rem 0 1rem" }}>
          {t("Gift links are retired.")}
        </h1>
        <p className="lede">
          {t("Ask your administrator for access to the base you need.")}
        </p>
        <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap", marginTop: "1.5rem" }}>
          <Link className="btn" href="/brains">{t("Workspace")}</Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
