import { NextRequest, NextResponse } from "next/server";
import { isAllowedPath } from "@/lib/route-gate";

/**
 * SVOD stage 2: private application boundary. There are no alternate
 * subdomains or public catalogue hosts in this fork — every host serves the
 * same private application. The middleware keeps the closed-mode gate and
 * the cookie hygiene below, and otherwise passes requests through;
 * authorization lives in the handlers and actions, not here.
 */
const SESSION_COOKIE = "__Secure-better-auth.session_token";

/** Paths that must behave identically whichever host they arrive on. */
function isInfrastructure(pathname: string): boolean {
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/brand") ||
    pathname.includes(".")
  );
}


/**
 * First touch, remembered for the visit.
 *
 * `?ref=` or `utm_source=` when the link carried one, otherwise the referring
 * host. Written once and never overwritten: by the time somebody signs up the
 * referrer is our own sign-in page, so last touch would credit mozg.sh for
 * every account we have.
 *
 * A cookie rather than a query string threaded through the auth flow, because
 * the flow leaves the site — GitHub OAuth and back — and a parameter does not
 * survive that. Lax and non-essential; it holds an origin, never a person.
 */
const SOURCE_COOKIE = "mozg_src";

/** lib/locales.ts owns this name; it is touched here only to clear a duplicate. */
const LOCALE_COOKIE = "mozg_lang";

/**
 * Drop a leftover host-only language cookie when a domain-scoped one exists.
 *
 * The language cookie used to be written without a Domain, so it stayed on
 * whichever host it was chosen on. It is now scoped to .mozg.sh — but writing
 * the new one does not replace the old: browsers key cookies by (name, domain,
 * path), so both are sent, host-only first, and `cookies().get()` returns that
 * one. A reader who picked Russian on gen.mozg.sh therefore got Russian there
 * and their old language on mozg.sh, which is the exact split the widening was
 * meant to end.
 *
 * Only when there really are two. A Set-Cookie with no Domain attribute targets
 * exactly the host-only copy, so the domain-scoped choice survives — but firing
 * this unconditionally would delete the choice of everyone who has only the old
 * cookie and has not re-picked since. Counting first is what makes it a
 * migration rather than a recurring surprise.
 */
function hasDuplicateLocale(req: NextRequest): boolean {
  const raw = req.headers.get("cookie") ?? "";
  return raw.split(";").filter((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`)).length > 1;
}

function dropDuplicateLocale(req: NextRequest, res: NextResponse): NextResponse {
  if (!hasDuplicateLocale(req)) return res;
  res.headers.append(
    "Set-Cookie",
    `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`,
  );
  return res;
}


function rememberSource(req: NextRequest, res: NextResponse): NextResponse {
  if (req.cookies.get(SOURCE_COOKIE)) return res;

  // Never bank a source from inside the sign-in round-trip. The OAuth callback
  // arrives with Referer: accounts.google.com, and where first touch had not
  // already banked a cookie that host won the bucket permanently — one of the
  // three accounts created since attribution shipped on 2026-08-12 reads
  // `accounts.google.com`, which names the consent screen someone passed
  // through rather than the place they came from, and is worse than null
  // because it looks like an answer.
  //
  // Matched on the path, not the host: github.com is an identity provider AND
  // one of the few referrers that genuinely matters for a developer tool, so
  // excluding the host would throw away the signal this column exists to
  // catch.
  if (req.nextUrl.pathname.startsWith("/api/auth/")) return res;

  const params = req.nextUrl.searchParams;
  const tagged = params.get("ref") ?? params.get("utm_source");
  let source = tagged?.trim().slice(0, 60);

  if (!source) {
    const referer = req.headers.get("referer");
    if (referer) {
      try {
        const host = new URL(referer).hostname.replace(/^www\./, "");
        // Our own pages are not a source; they are the visit continuing.
        if (!host.endsWith("mozg.sh")) source = host.slice(0, 60);
      } catch {
        // A malformed Referer is not worth a 500 on every page load.
      }
    } else {
      // No referrer and no tag: typed, bookmarked, or stripped by the
      // referrer policy of wherever they came from. Worth telling apart from
      // "we never looked", which is what null now means.
      source = "direct";
    }
  }
  if (!source) return res;

  res.cookies.set(SOURCE_COOKIE, source, {
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    path: "/",
    httpOnly: false,
  });
  return res;
}

/**
 * The whole service is paused while mozg 2.0 is built (2026-09-23). Every page
 * on every host serves /closed; sign-in and /admin stay reachable so the
 * operator can still work, and /api stays up so payment webhooks and auth keep
 * landing. MCP is closed in lib/mcp-rpc.ts. Reopen: set false and deploy.
 * Reopened 2026-10-08.
 */
export const CLOSED = false;

function closedAllows(pathname: string): boolean {
  return (
    pathname === "/closed" ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/mcp") ||
    isInfrastructure(pathname)
  );
}

export function middleware(req: NextRequest) {
  if (CLOSED && !closedAllows(req.nextUrl.pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/closed";
    url.search = "";
    // 503 + Retry-After: crawlers read it as "down for now", not "gone".
    return NextResponse.rewrite(url, { status: 503, headers: { "Retry-After": "86400" } });
  }

  // SVOD: no alternate-subdomain surface. gallery./gen./learn. hosts serve
  // the same private application as the main host — no rewrites, no
  // cross-host redirects. Authorization lives in handlers, not here.
  //
  // Default-deny perimeter: anything outside the retained private surface
  // 404s here, before old routing logic runs, regardless of old public
  // flags. See lib/route-gate.ts for the explicit allowlist.
  if (!isAllowedPath(req.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  // Main site cookie hygiene below: note where this visit came from, and
  // clear a stale duplicate locale cookie when a domain-scoped one exists.
  // Two same-name session cookies at different scopes is a real problem: one
  // left over from before the cookie widened to .mozg.sh, one current, and the
  // server reads the stale one first — which is how a successful OAuth used to
  // bounce back to the sign-in form.
  //
  // So delete only the legacy host-only cookie, and leave the domain-scoped one
  // — the live session — alone. Anyone still holding only that cookie is signed
  // out once, on the form, which is the migration this always meant to be
  // rather than a recurring surprise.
  if (
    (req.headers.get("host") ?? "").startsWith("mozg.sh") &&
    req.nextUrl.pathname === "/sign-in"
  ) {
    const res = NextResponse.next();
    res.headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    return dropDuplicateLocale(req, rememberSource(req, res));
  }
  return dropDuplicateLocale(req, rememberSource(req, NextResponse.next()));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
