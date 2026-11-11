import StarBannerClient from "./StarBannerClient";
import { liveAnnouncements } from "@/lib/announcements";

const REPO = "egorfedorov/mozg";

/**
 * The star bar. One line above everything: what we are, how many people
 * starred it, and a link that goes straight to the star action.
 *
 * The count is fetched server-side and cached for an hour — GitHub's
 * unauthenticated limit is 60 requests an hour per IP, which one busy
 * minute would burn. A failed fetch renders the bar without a number
 * rather than removing it: the ask matters more than the count.
 */
export default async function StarBanner() {
  // Never two bars at once. An announcement is the more urgent of the two by
  // definition — it is why somebody's ingest is paused or what they need to
  // update — and stacking the star ask on top of it pushed the page's own
  // headline below the fold. The ask waits for a quiet day.
  if ((await liveAnnouncements()).length) return null;

  let stars: number | null = null;
  try {
    // Bounded: sign-in renders offline instead of hanging on GitHub.
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) stars = ((await res.json()) as { stargazers_count?: number }).stargazers_count ?? null;
  } catch {
    // No count, still an ask.
  }

  return (
    <>
      <StarBannerClient stars={stars} repo={REPO} />
      {/* Runs before paint, immediately after the bar's markup: a returning
          visitor who dismissed it never sees it, and a first-timer gets no
          layout shift. Flags <html> instead of removing the bar — the node is
          React's, and deleting it before hydration cost the page its whole
          tree (see the banner-star-off rule in globals.css). */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "try{if(localStorage.getItem('star-banner-dismissed'))" +
            "document.documentElement.classList.add('banner-star-off')}catch(e){}",
        }}
      />
    </>
  );
}
