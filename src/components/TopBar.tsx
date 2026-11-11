import { markup } from "@/lib/markup";
import Link from "next/link";
import { translator } from "@/lib/t";
import { currentUser } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import LanguagePicker from "@/components/LanguagePicker";
import { currentLocale } from "@/lib/t";

/**
 * The header for the public side of the site.
 *
 * One navigation per page. Everything readable — why, the comparison, both
 * guides, connect, the catalogue — lives in the contents strip underneath, so
 * the bar carries only identity and the way out of reading: sign in, or back
 * to your own work.
 *
 * It used to repeat connect, guide and the catalogue in both rows, which is the
 * same two-navigations mistake the admin console had. Signed-in workspace pages
 * do not render this at all; they have the rail.
 */
export default async function TopBar({ active }: { active?: string }) {
  const t = await translator();
  const [user, locale] = await Promise.all([currentUser(), currentLocale()]);

  return (
    <header className="topbar">
      <div className="shell topbar-inner">
        <span style={{ display: "flex", alignItems: "center", gap: ".6rem", marginRight: "auto" }}>
          <Link href="/" className="wordmark" style={{ marginRight: 0 }}>
            {markup(t("svod<0>.</0>"), [
            <span key="s0" />,
          ])}</Link>
        </span>

        {/* Left of whoever you are, signed in or not: the reader who needs it
            is the reader who cannot read the label next to it, so it has to be
            findable without reading anything. */}
        <LanguagePicker current={locale} />

        {user ? (
          <>
            {isAdmin(user) && (
              <Link
                className="navlink hide-sm"
                data-active={active === "admin"}
                href="/admin"
                style={{ color: "var(--color-riso-red)" }}
              >
                {t("admin")}
              </Link>
            )}
            <Link
              className="navlink hide-sm"
              data-active={active === "account"}
              href="/settings"
              style={{ color: "var(--ink-3)" }}
            >
              {user.handle ?? user.email}
            </Link>
            <Link className="btn" href="/brains">
              {t("Your brains")}
            </Link>
          </>
        ) : (
          <Link className="btn" href="/sign-in">
            {t("Sign in")}
          </Link>
        )}
      </div>
    </header>
  );
}
