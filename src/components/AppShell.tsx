import { markup } from "@/lib/markup";
import { translator } from "@/lib/t";
import { msg } from "@/lib/msg";
import Link from "next/link";
import SignOutLink from "@/components/SignOutLink";
import { currentUser } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

/**
 * The signed-in half of the product. Everything you do to your own account —
 * brains, connecting an agent, money, tokens — sits inside this one frame, so
 * moving between them never feels like leaving the app.
 *
 * The marketing pages deliberately do not use it: they end in a footer full of
 * links out, which is the opposite of what a workspace wants.
 */

const GROUPS: {
  title: string;
  items: { href: string; label: string; hint?: string; badge?: number }[];
}[] = [
  {
    title: msg("Work"),
    items: [
      { href: "/brains", label: msg("Bases") },
      { href: "/brains/new", label: msg("New base") },
      { href: "/connect", label: msg("Connect an agent") },
    ],
  },
  {
    title: msg("Account"),
    items: [
      { href: "/settings/tokens", label: msg("Tokens") },
      { href: "/settings", label: msg("Profile") },
    ],
  },
];

export default async function AppShell({
  active,
  title,
  eyebrow,
  action,
  narrow,
  children,
}: {
  /** href of the current page, for the nav */
  active: string;
  /** Omit when the page renders its own heading (a brain page, say). */
  title?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  narrow?: boolean;
  children: React.ReactNode;
}) {
  const t = await translator();

  const user = await currentUser();
  if (!user) return null; // callers redirect; this is belt and braces

  // SVOD: no billing/chat badges in the workspace. The operator manages people
  // from /admin/users; waiting chat/errors live outside the retained surface.

  // SVOD: no public "Your page" — the two-segment legacy profile stays denied
  // by the perimeter and is never linked from the workspace.
  const base = GROUPS;

  const groups = isAdmin(user)
    ? [
        ...base,
        {
          title: "Operator",
          items: [
            { href: "/admin", label: "System" },
            { href: "/admin/users", label: "People" },
          ],
        },
      ]
    : base;

  return (
    <div className="app">
      <aside className="app-rail">
        {/* Below 900px the rail is a bar across the top and everything under
            the wordmark collapses behind this toggle. A checkbox rather than
            React state on purpose: the shell is a server component, and a
            phone that has not finished hydrating still has to be able to open
            the only navigation the workspace has. Desktop never shows it. */}
        <input type="checkbox" id="app-nav-open" className="app-nav-check" aria-label={t("Menu")} />

        <div className="app-rail-head">
          <Link href="/" className="wordmark" style={{ fontSize: "1.25rem" }}>
            {markup(t("svod<0>.</0>"), [
            <span key="s0" />,
          ])}</Link>

          <label htmlFor="app-nav-open" className="app-burger mono">
            <span className="app-burger-shut">{t("☰ menu")}</span>
            <span className="app-burger-open">{t("✕ close")}</span>
          </label>
        </div>

        <div className="app-rail-body">
          <Link href="/settings" className="app-me">
            <span className="app-avatar" aria-hidden>
              {(user.handle ?? user.email)[0]?.toUpperCase() ?? "?"}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="app-me-name">{user.handle ?? user.email.split("@")[0]}</span>
              <span className="app-me-sub">{user.email}</span>
            </span>
          </Link>

          <nav className="app-nav">
            {groups.map((g) => (
              <div key={g.title}>
                <p className="eyebrow app-nav-title">{t(g.title)}</p>
                {g.items.map((i) => (
                  <Link key={i.href} href={i.href} data-active={i.href === active}>
                    {t(i.label)}
                    {(i.badge ?? 0) > 0 && <span className="nav-badge">{i.badge}</span>}
                  </Link>
                ))}
              </div>
            ))}

            <div>
              <p className="eyebrow app-nav-title">{t("Elsewhere")}</p>
              <SignOutLink />
            </div>
          </nav>
        </div>
      </aside>

      <div className="app-main" style={narrow ? { maxWidth: 820 } : undefined}>
        {title && (
          <header className="app-head">
            <div style={{ minWidth: 0 }}>
              {eyebrow && <p className="eyebrow">{eyebrow}</p>}
              <h1 className="display app-title">{title}</h1>
            </div>
            {action}
          </header>
        )}

        {children}
      </div>
    </div>
  );
}
