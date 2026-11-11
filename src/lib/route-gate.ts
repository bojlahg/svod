/**
 * Default-deny route perimeter (SVOD private fork).
 *
 * The middleware removed its alternate-subdomain rewrites but still passed
 * everything else through, so retired public surfaces (/learn, /health,
 * /styles, /gallery, /packs, /pricing, legacy /api/packs and payments, …)
 * kept serving whatever their handlers answered. This is the explicit
 * allowlist for the retained private application; anything else is denied
 * in middleware before old routing logic runs. Authorization itself still
 * lives in the retained handlers and actions — this gate only closes doors
 * that should not exist at all.
 *
 * Retained: root, sign-in, /brains subtree, /b/{handle}/{slug} compatibility
 * detail/notes (3+ segments — the two-segment legacy profile is denied),
 * /admin, /settings (+/tokens), /connect, /api/auth, /api/ready, /api/health,
 * /api/brains, /api/storage, /mcp, and the static assets retained surfaces
 * render. Everything else 404s regardless of old public flags.
 */

const EXACT = new Set([
  "/",
  "/sign-in",
  "/closed",
  "/settings",
  "/settings/tokens",
  "/favicon.ico",
  "/robots.txt",
  "/manifest.webmanifest",
]);

const PREFIX = [
  "/brains",
  "/admin",
  "/connect",
  "/api/auth",
  "/api/ready",
  "/api/health",
  "/api/brains",
  "/api/storage",
  "/mcp",
  "/_next",
  // Static assets rendered by retained surfaces.
  "/brand/",
  "/fonts/",
  "/achievements/",
  "/about/",
];

export function isAllowedPath(pathname: string): boolean {
  if (EXACT.has(pathname)) return true;
  // Compatibility detail/notes need owner + slug (and anything deeper, e.g.
  // opengraph-image). The two-segment legacy profile stays denied.
  if (pathname.startsWith("/b/")) {
    return pathname.split("/").filter(Boolean).length >= 3;
  }
  for (const p of PREFIX) {
    if (p.endsWith("/")) {
      if (pathname.startsWith(p)) return true;
    } else if (pathname === p || pathname.startsWith(`${p}/`)) {
      return true;
    }
  }
  return false;
}
