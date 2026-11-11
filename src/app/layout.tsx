import { localeOf } from "@/lib/locales";
import { currentLocale, clientDictionary, translator } from "@/lib/t";
import { Translations } from "@/lib/t-client";
import type { Metadata } from "next";
import { env } from "@/lib/env";
import ClientErrorReporter from "@/components/ClientErrorReporter";
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
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    title: t("svod — private local base"),
    description: t("Private Markdown bases with folders, search and MCP access."),
    ...(env.GOOGLE_SITE_VERIFICATION
      ? { verification: { google: env.GOOGLE_SITE_VERIFICATION } }
      : {}),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = localeOf(await currentLocale());
  const dict = await clientDictionary();

  return (
    <html lang={locale.code} dir={locale.rtl ? "rtl" : undefined}>
      <body>
        <Translations dict={dict}>
          {children}
          <ClientErrorReporter />
        </Translations>
      </body>
    </html>
  );
}
