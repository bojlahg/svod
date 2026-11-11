import { localeOf } from "@/lib/locales";
import { currentLocale, clientDictionary, translator } from "@/lib/t";
import { Translations } from "@/lib/t-client";
import type { Metadata } from "next";
import { env } from "@/lib/env";
import StarBanner from "@/components/StarBanner";
import AnnouncementBanner from "@/components/AnnouncementBanner";
import MascotDock from "@/components/MascotDock";
import MachineView from "@/components/MachineView";
import { machineDoc } from "@/lib/machine";
import { currentUser } from "@/lib/session";
import ClientErrorReporter from "@/components/ClientErrorReporter";
import CookieConsent from "@/components/CookieConsent";
import Analytics from "@/components/Analytics";
import "./fonts.css";
import "./globals.css";

/**
 * Fonts are vendored into public/fonts and declared in fonts.css, not fetched
 * by next/font/google.
 *
 * That helper downloads from fonts.gstatic.com at build time, so every build —
 * here, in CI, on a self-hoster's laptop behind a firewall — depended on a
 * third party answering. It failed twice in one afternoon with "Error while
 * requesting resource" and nothing wrong in the code. A build that breaks for
 * reasons outside the repository is one nobody can reproduce or trust.
 *
 * Cyrillic is carried on its own unicode-range subset rather than merged in:
 * brains hold Russian notes, a fallback glyph in a note title is the fastest
 * way to make a product feel unfinished, and an English-only reader still
 * downloads only the Latin file. See scripts/fetch-fonts.mjs.
 */
/**
 * The site-wide fallback, and the tab title of every page that does not set its
 * own. Async because a title is a sentence somebody reads, and a static export
 * is evaluated before there is a request to read the reader's language from.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await translator();
  return {
  // Absolute URLs for every og:/twitter: tag below — without a base, crawlers
  // get relative paths and the share card silently loses its image.
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  title: t("mozg — one brain, every agent"),
  description:
    t("Build a knowledge brain from screenshots and files, then connect it to Claude Code, Codex and Cursor over MCP."),
  ...(env.GOOGLE_SITE_VERIFICATION
    ? { verification: { google: env.GOOGLE_SITE_VERIFICATION } }
    : {}),
  // The machine view of this page, as a fetchable URL. An agent handed a link
  // to any page can find the fact sheet from the markup instead of being told
  // the address, and the extractors that strip the in-page sheet cannot strip
  // a <link>.
  alternates: {
    types: {
      "text/plain": [{ url: "/machine.txt", title: t("mozg as a fact sheet") }],
    },
  },
  openGraph: {
    siteName: "mozg",
    type: "website",
    // Declared here or the card below is a promise nothing keeps: twitter.card
    // has said summary_large_image since launch while fifteen of sixteen public
    // pages shipped no image at all, so every share of mozg.sh has rendered an
    // empty slot. Brain pages generate their own (b/[handle]/[slug]/
    // opengraph-image.tsx) and override this; everything else inherits it.
    images: [
      {
        url: "/brand/devto-cover.jpg",
        width: 2752,
        height: 1536,
        alt: t("mozg — one brain, every agent"),
      },
    ],
  },
  twitter: {
      card: "summary_large_image",
    },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = localeOf(await currentLocale());
  // Loaded here and nowhere else. Every client component on the site reads it
  // out of one context, so a page cannot forget to provide it and quietly go
  // back to English.
  const dict = await clientDictionary();
  // Only to decide whether this render is a workspace screen; currentUser is
  // memoised per request, so this costs nothing the dock was not already paying.
  const signedIn = Boolean(await currentUser());

  return (
    // dir matters more than lang does: Arabic and Urdu laid out left-to-right
    // are not "slightly off", they are unreadable.
    <html lang={locale.code} dir={locale.rtl ? "rtl" : undefined}>
      {/* No footer here on purpose: it belongs to the public side of the site.
          A workspace ends in work, not in a wall of links out. */}
      <body>
        <Translations dict={dict}>
          <AnnouncementBanner />
          {/* Keep authenticated renders independent of the external
              promotional counter. */}
          {signedIn ? null : <StarBanner />}
          {children}
          {/* Last in the body, fixed in the corner: it must not participate in the
              page's layout, only sit above it. */}
          <MascotDock />
          {/* The document is built on the server so the numbers in it come from
              the modules that enforce them; the client half only knows which page
              it is on. It renders nothing on the workspace side of the site. */}
          <MachineView doc={machineDoc()} signedIn={signedIn} />
          <ClientErrorReporter />
          {/* Above Analytics in the tree and ahead of it in effect: the loader
              reads the cookie this writes, so an unanswered banner means an
              unloaded tracker. */}
          <CookieConsent />
          <Analytics />
        </Translations>
      </body>
    </html>
  );
}
