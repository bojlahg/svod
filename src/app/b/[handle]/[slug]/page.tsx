import Link from "next/link";
import { parseTools } from "@/lib/brain-tools";
import { installCommand } from "@/lib/plugins";
import { markup, fill } from "@/lib/markup";
import { translator } from "@/lib/t";
import { msg } from "@/lib/msg";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import TopBar from "@/components/TopBar";
import SiteFooter from "@/components/SiteFooter";
import Contents from "@/components/Contents";
import BuyBrain from "@/components/BuyBrain";
import AddBrain from "@/components/AddBrain";
import CopyMcpCommand from "./CopyMcpCommand";
import ReviewBox from "./ReviewBox";
import { query } from "@/db";
import { env } from "@/lib/env";
import { accessForSlug } from "@/lib/access";
import { categoryScores, tintFor } from "@/lib/brains";
import { currentUser } from "@/lib/session";
import { topicLabel } from "@/lib/topics";
import { inLibrary } from "@/lib/library";
import { accessibleChildren, parentOf } from "@/lib/families";
import { agentsTaught } from "@/lib/agent-report";
import { gateFor } from "@/lib/paywall";
import { packBySlug, packsWith } from "@/lib/packs";
import { brainsIn } from "@/lib/pack-brains";
import { holdsAnyPack } from "@/lib/pack-access";
import InPack from "@/components/InPack";
import { anyCryptoReady } from "@/lib/payments";
import { isoDate } from "@/lib/dates";
import { examTrend, trendLine } from "@/lib/exam-trend";

/**
 * The public face of a brain. This is the page that gets indexed and shared,
 * so it has to answer "what does this know, and how well" without a sign-in.
 */

const LICENSE: Record<string, { label: string; detail: string }> = {
  nc: {
    label: msg("CC BY-NC-SA 4.0"),
    detail: msg("Use it, copy it, build on it, with credit. Selling it is not allowed."),
  },
  mit: {
    label: msg("MIT"),
    detail: msg("Do anything, including reselling or shipping it inside a paid product."),
  },
  proprietary: {
    label: msg("Closed"),
    detail: msg("Readable through MCP only. No export, no copying."),
  },
};

// Both the page and generateMetadata query the database per request.
export const dynamic = "force-dynamic";

const STATE_SIGIL = { pass: "✓", partial: "▲", fail: "✕", empty: "·" } as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}): Promise<Metadata> {
  // SVOD: no public metadata. Anonymous or ungranted callers learn nothing
  // about the base from headers, cards or indexes.
  const { handle, slug } = await params;
  const { currentUser } = await import("@/lib/session");
  const { brainAccessByHandleSlug } = await import("@/lib/svod-access");
  const user = await currentUser();
  if (!user) return { title: "svod", robots: { index: false, follow: false } };
  const found = await brainAccessByHandleSlug(handle, slug, user.id);
  if (!found?.canRead) return { title: "svod", robots: { index: false, follow: false } };
  const title = `${found.brain.title} — a svod base`;
  const description = found.brain.goal ?? undefined;
  return {
    title,
    description,
    robots: { index: false, follow: false },
  };
}

export default async function PublicBrainPage({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}) {
  const t = await translator();

  const { handle, slug } = await params;
  const user = await currentUser();
  const found = await accessForSlug(handle, slug, user?.id ?? null);
  // Locked paid brains still render — as a storefront, not as content.
  if (!found || (!found.access && !found.preview)) notFound();

  const { brain, preview } = found;
  // Owner-authored and shown to strangers, so it goes through the same parse
  // the agent-facing side uses — the caps and the control-character strip are
  // the point, not a formality.
  const publicTools = parseTools(brain.tools);

  // The last two sittings, diffed: what the brain learned between them is
  // the collective-mind claim made visible on the shop floor.
  const examDiff = await query<{ gained: number; lost: number }>(
    `with runs as (
       select id, row_number() over (order by started_at desc) as rn
         from check_runs where brain_id = $1 and status = 'done' and kind = 'full' limit 2
     )
     select count(*) filter (where cur.passed and prev.passed is distinct from true)::int as gained,
            count(*) filter (where not cur.passed and prev.passed)::int as lost
       from check_results cur
       join runs r1 on r1.id = cur.run_id and r1.rn = 1
       left join check_results prev
         on prev.check_id = cur.check_id
        and prev.run_id = (select id from runs where rn = 2)
      where (select count(*) from runs) = 2`,
    [brain.id],
  ).then((r) => r[0] ?? { gained: 0, lost: 0 });

  const [categories, samples, balance, added, children, parent, passedChecks, examTotals, trend] =
    await Promise.all([
    categoryScores([brain.id]).then((m) => m.get(brain.id) ?? []),
    // Titles are the shop window: enough to judge whether the brain is worth
    // buying, never the bodies that were paid for.
    query<{ title: string; category: string | null }>(
      `select title, category from notes
        where brain_id = $1 and status = 'active'
        order by created_at desc limit ${preview ? 8 : 14}`,
      [brain.id],
    ),
    user
      ? query<{ balance_cents: number }>(
          `select balance_cents from "user" where id = $1`,
          [user.id],
        ).then((r) => r[0]?.balance_cents ?? 0)
      : Promise.resolve(null),
    user ? inLibrary(user.id, brain.id) : Promise.resolve(false),
    brain.parent_id ? Promise.resolve([]) : accessibleChildren(brain.id, user?.id ?? null),
    parentOf(brain),
    // Questions the brain passed on its own latest exam. The strongest thing
    // a storefront can show: not the author's claim, the grader's receipt.
    // Questions only, never the answers — those are what is being sold.
    // Positive checks only: a passed negative probe means "rightly has no
    // answer", which is a strange thing to ask a brain for.
    query<{ question: string; category: string }>(
      `select c.question, c.category
         from check_results r join checks c on c.id = r.check_id
        where r.run_id = (
          select id from check_runs where brain_id = $1 and status = 'done'
          order by started_at desc limit 1
        ) and r.passed and c.kind = 'positive' and c.enabled
        order by c.weight desc, c.category
        limit 8`,
      [brain.id],
    ),
    // The receipt's totals: how much of its own exam the brain passes, and
    // how cleanly it refuses what is out of scope (anti-bluff probes).
    query<{ pos_passed: number; pos_total: number; neg_passed: number; neg_total: number }>(
      `select count(*) filter (where c.kind = 'positive' and r.passed)::int as pos_passed,
              count(*) filter (where c.kind = 'positive')::int as pos_total,
              count(*) filter (where c.kind = 'negative' and r.passed)::int as neg_passed,
              count(*) filter (where c.kind = 'negative')::int as neg_total
         from check_results r join checks c on c.id = r.check_id
        where r.run_id = (
          select id from check_runs where brain_id = $1 and status = 'done'
          order by started_at desc limit 1
        )`,
      [brain.id],
    ).then((r) => r[0] ?? null),
    examTrend(brain.id),
  ]);

  // What actually has to be bought. For a child of a paid family that is the
  // parent — buying the child is not a thing, and offering it without a price
  // would be offering something that does not exist.
  const gate = await gateFor(brain);

  // The report card: which agents taught this brain, and how their notes
  // performed as exam evidence. The strongest version of the collective-mind
  // claim a storefront can make — attribution from the grader, not copy.
  const taught = await agentsTaught([brain.id, ...children.map((c) => c.id)]);

  // The red team's latest verdicts — measured resistance, dated. Only shown
  // when a run exists; a storefront must never imply a test that did not run.
  const redteam = await query<{ attack: string; survived: boolean; detail: string | null; ran: string }>(
    `select attack, survived, detail,
            to_char(ran_at at time zone 'UTC', 'YYYY-MM-DD') as ran
       from redteam_runs where brain_id = $1 order by attack`,
    [brain.id],
  );

  const [rating, latestReviews, myReview] = await Promise.all([
    query<{ avg: string | null; n: number }>(
      `select round(avg(rating), 1)::text as avg, count(*)::int as n
         from reviews where brain_id = $1`,
      [brain.id],
    ).then((r) => r[0]),
    query<{ rating: number; body: string; handle: string | null; at: string }>(
      `select r.rating, r.body, u.handle,
              to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD') as at
         from reviews r join "user" u on u.id = r.buyer_id
        where r.brain_id = $1 and r.body <> ''
        order by r.created_at desc limit 3`,
      [brain.id],
    ),
    user
      ? query<{ rating: number; body: string }>(
          `select rating, body from reviews where brain_id = $1 and buyer_id = $2`,
          [brain.id, user.id],
        ).then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  // Exactly three states, so the page never shows two calls to action or none.
  //   locked  — paid and not bought yet
  //   have    — already in this reader's set, or their own
  //   free    — readable and not added yet
  const owns = brain.owner_id === user?.id;
  const familyAdded = gate ? await inLibrary(user?.id ?? "", gate.brainId) : false;
  const state = preview ? "locked" : owns || added || familyAdded ? "have" : "free";

  // The pack this brain belongs to, if any — named whether the reader has it
  // or not, because a page that only quotes the single price hides the cheaper
  // way to the same material.
  const packSlug = packsWith(brain.slug, parent?.slug ?? null)[0];
  const pack = packSlug ? packBySlug(packSlug) : undefined;
  const [packBrains, packHeld] = pack
    ? await Promise.all([brainsIn(pack), holdsAnyPack(user?.id ?? null, [pack.slug])])
    : [[], false];

  const licence = LICENSE[brain.license];

  // Structured data for search engines and AI assistants: a brain is a
  // product with a real price and a real description. Only public facts —
  // no note bodies, no exam internals.
  const jsonLd =
    brain.visibility === "public"
      ? {
          "@context": "https://schema.org",
          "@type": "Product",
          name: brain.title,
          description: brain.goal ?? undefined,
          url: `${env.NEXT_PUBLIC_APP_URL}/b/${handle}/${slug}`,
          // Google reads any Product with an offer as a merchant listing and
          // treats a missing image as a hard error, so the card is dropped
          // from results entirely. The OG card is the picture of a brain we
          // already generate; the route serves it without the cache-busting
          // query metadata adds.
          image: `${env.NEXT_PUBLIC_APP_URL}/b/${handle}/${slug}/opengraph-image`,
          brand: { "@type": "Brand", name: "mozg" },
          offers: {
            "@type": "Offer",
            price: ((brain.price_cents ?? 0) / 100).toFixed(2),
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            url: `${env.NEXT_PUBLIC_APP_URL}/b/${handle}/${slug}`,
            // The same report warns about the two policies every physical
            // good needs. A brain is delivered over MCP the moment it is
            // bought: nothing ships, and nothing can be sent back.
            shippingDetails: {
              "@type": "OfferShippingDetails",
              shippingRate: { "@type": "MonetaryAmount", value: "0", currency: "USD" },
              shippingDestination: {
                "@type": "DefinedRegion",
                addressCountry: "US",
              },
              deliveryTime: {
                "@type": "ShippingDeliveryTime",
                handlingTime: {
                  "@type": "QuantitativeValue",
                  minValue: 0,
                  maxValue: 0,
                  unitCode: "DAY",
                },
                transitTime: {
                  "@type": "QuantitativeValue",
                  minValue: 0,
                  maxValue: 0,
                  unitCode: "DAY",
                },
              },
            },
            hasMerchantReturnPolicy: {
              "@type": "MerchantReturnPolicy",
              applicableCountry: "US",
              // MerchantReturnNotRequired reads like the right sentence and is
              // not a member of MerchantReturnEnumeration at all — Search
              // Console flagged it as an invalid enum. The three real values
              // are FiniteReturnWindow, UnlimitedWindow and NotPermitted; for
              // something delivered over MCP the second it is bought, with
              // nothing to send back, the last one is the accurate one. It
              // does not touch the statutory refunds clause in /terms, which
              // is law rather than a returns policy.
              returnPolicyCategory:
                "https://schema.org/MerchantReturnNotPermitted",
            },
          },
        }
      : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <TopBar />
      <Contents active="/explore" />

      <main className="shell" style={{ paddingBlock: "clamp(2rem, 5vw, 3.5rem)" }}>
        <p className="eyebrow">
          <Link href="/explore">{t("explore")}</Link> /{" "}
          <Link href={`/explore?topic=${brain.topic}`}>{topicLabel(brain.topic)}</Link> /{" "}
          {handle}
          {parent && (
            <>
              {" / "}
              <Link href={`/b/${handle}/${parent.slug}`}>{parent.title}</Link>
            </>
          )}
        </p>

        <div
          style={{
            display: "flex",
            gap: "1.5rem",
            alignItems: "flex-start",
            flexWrap: "wrap",
            margin: "1rem 0 2.5rem",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 56,
              height: 56,
              border: "1.5px solid var(--ink)",
              background: `var(--color-riso-${tintFor(brain)})`,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 260 }}>
            <h1 className="h1">
              {brain.title}
            </h1>
            <p style={{ color: "var(--ink-2)", margin: ".6rem 0 0", maxWidth: "60ch" }}>
              {brain.goal ?? t("No goal set.")}
            </p>
            {/* What this knowledge is worked with. A buyer weighing a brain
                about Spine deserves to know it assumes Spine on the machine —
                after the purchase is the wrong time to find that out. */}
            {publicTools.length > 0 && (
              <div
                style={{
                  marginTop: ".9rem",
                  borderLeft: "3px solid var(--color-riso-violet)",
                  paddingLeft: ".75rem",
                  maxWidth: "60ch",
                }}
              >
                <p className="eyebrow" style={{ margin: 0 }}>
                  {t("Works with — on your machine, not ours")}
                </p>
                {publicTools.map((x) => (
                  <p key={x.name} style={{ margin: ".35rem 0 0", fontSize: ".9375rem" }}>
                    <strong className="mono">{x.name}</strong>
                    <span style={{ color: "var(--ink-2)" }}> — {x.what}</span>
                    {x.needs && (
                      <span className="mono" style={{ display: "block", fontSize: ".6875rem", color: "var(--ink-3)" }}>
                        {t("needs")}: {x.needs}
                      </span>
                    )}
                    {x.plugin && installCommand(x.plugin) && (
                      <span className="mono" style={{ display: "block", fontSize: ".6875rem" }}>
                        {installCommand(x.plugin)}
                      </span>
                    )}
                  </p>
                ))}
              </div>
            )}
            <p
              className="mono"
              style={{ fontSize: ".75rem", color: "var(--ink-3)", marginTop: ".75rem" }}
            >
              {markup(t("<0/> notes<1/> · updated <2/> · <3/> <4/>"), [
              (brain.note_count + children.reduce((n, c) => n + c.note_count, 0)).toLocaleString(),
              children.length > 0 ? ` across ${children.length + 1} brains` : "",
              isoDate(brain.updated_at),
              brain.score === null ? t("not examined") : `trained ${brain.score}%`,
              rating.n > 0 && ` · ★ ${rating.avg} (${rating.n})`,
            ])}</p>
            {(examDiff.gained > 0 || examDiff.lost > 0) && (
              <p className="mono" style={{ fontSize: ".75rem", marginTop: ".35rem" }}>
                <span style={{ color: "var(--color-riso-green)" }}>
                  {markup(t("since last sitting: +<0/> newly passed"), [examDiff.gained])}
                </span>
                {examDiff.lost > 0 && (
                  <span style={{ color: "var(--color-riso-red)" }}>
                    {" "}
                    {markup(t("· −<0/> lost"), [examDiff.lost])}
                  </span>
                )}
                {" "}
                {markup(t("— this brain is learning · <0>the verified changelog →</0>"), [
                  <Link
                    href={`/b/${handle}/${brain.slug}/changes`}
                    style={{ textDecoration: "underline" }}
                    key="s0"
                  />,
                ])}
              </p>
            )}
          </div>
        </div>

        {/* The conversion block, first — Discord feedback was blunt: the way
            in was squeezed at the bottom while a list of exam questions got
            the fold. Terminal wide on the left, add-to-brains beside it. */}
        <div
          style={{
            display: "flex",
            gap: "1.5rem",
            alignItems: "stretch",
            flexWrap: "wrap",
            margin: "0 0 2.5rem",
          }}
        >
          {/* A column, not a bare div: it holds the terminal (or the buy box)
              AND the pack strip under it. The terminal asks for height:100% to
              match the panel beside it, which with a sibling below meant 100%
              PLUS the strip — so the strip spilled out of the row and landed
              on top of the reviews. flex-column gives the terminal the leftover
              instead of the whole thing. */}
          <div
            style={{
              flex: "3 1 340px",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            {preview ? (
              <BuyBrain
                handle={handle}
                slug={gate && gate.brainId !== brain.id && parent ? parent.slug : brain.slug}
                priceCents={gate?.priceCents ?? brain.price_cents}
                partOf={gate && gate.brainId !== brain.id ? (parent?.title ?? null) : null}
                balanceCents={balance}
                signedIn={Boolean(user)}
                cryptoReady={anyCryptoReady}
              />
            ) : (
              <section className="term" style={{ fontSize: ".9375rem", flex: 1 }}>
                <div className="term-bar">
                  <span className="term-dot" />
                  <span className="term-dot" />
                  <span className="term-dot" />
                  <span style={{ marginLeft: ".5rem" }}>{t("use this brain")}</span>
                </div>
                <div className="c">
                  {user ? t("# your token from /settings/tokens") : t("# sign in to get a token")}
                </div>
                <div style={{ wordBreak: "break-all" }}>
                  {markup(t("<0>$</0> claude mcp add --transport http mozg \\"), [
                  <span className="c" key="s0" />,
                ])}</div>
                <div style={{ wordBreak: "break-all", paddingLeft: "1.5rem" }}>
                  {t("/mcp --header \"Authorization: Bearer …\"")}</div>
                <div style={{ marginTop: ".9rem" }}>
                  {markup(t("<0>&gt;</0> use <1/>/<2/> — …"), [
                  <span className="u" key="s0" />,
                  handle,
                  brain.slug,
                ])}</div>
                <div style={{ display: "flex", gap: ".75rem", alignItems: "center", flexWrap: "wrap" }}>
                  {user ? (
                    <CopyMcpCommand signedIn />
                  ) : (
                    <Link
                      className="btn"
                      href="/sign-in"
                      style={{
                        marginTop: "1rem",
                        background: "var(--color-riso-yellow)",
                        color: "var(--ink)",
                        borderColor: "var(--color-riso-yellow)",
                      }}
                    >
                      {t("Sign in — get this command with your token in it")}</Link>
                  )}
                </div>
                {!user && (
                  // For someone landing here from a Discord link with zero
                  // context: one sentence, no jargon, says exactly what
                  // signing in buys them.
                  <p style={{ margin: ".75rem 0 0", color: "#9aa1ab", fontSize: ".8125rem", fontFamily: "inherit" }}>
                    {t("New here? Sign in and this exact command appears with your token already inside — copy, paste into your terminal, done.")}</p>
                )}
              </section>
            )}

            {/* Shown in both states on purpose. Locked, it is the cheaper way
                to the same material; unlocked, it is where the rest of what
                this reader holds actually lives. */}
            {pack && (
              <InPack
                pack={pack}
                brains={packBrains.length}
                held={packHeld}
                singleCents={gate?.priceCents ?? brain.price_cents}
              />
            )}
          </div>

          {state === "free" || (state === "have" && !owns) ? (
            <div style={{ flex: "2 1 280px", minWidth: 0 }}>
              <AddBrain
                brainId={brain.id}
                handle={`${handle}/${brain.slug}`}
                signedIn={Boolean(user)}
                added={added || familyAdded}
              />
            </div>
          ) : null}
        </div>

        {(latestReviews.length > 0 || (state === "have" && !owns) || myReview) && (
          <section style={{ margin: "0 0 2.5rem" }}>
            {latestReviews.length > 0 && (
              <>
                <div className="section-head">
                  <h2 className="h2">{t("From buyers")}</h2>
                  <span className="eyebrow">{markup(
                    rating.n === 1 ? t("★ <0/> · <1/> rating") : t("★ <0/> · <1/> ratings"),
                    [rating.avg, rating.n],
                  )}</span>
                </div>
                <div className="rows" style={{ marginBottom: "1rem" }}>
                  {latestReviews.map((r, i) => (
                    <div key={i} className="row">
                      <span style={{ minWidth: 0 }}>
                        <strong>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</strong>
                        <span className="row-sub">{r.body}</span>
                        <span className="row-meta">{r.handle ?? "buyer"} · {r.at}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {(state === "have" && !owns) && (
              <ReviewBox handle={handle} slug={brain.slug} existing={myReview} />
            )}
          </section>
        )}

        {passedChecks.length > 0 && (
          <section style={{ margin: "0 0 2.5rem" }}>
            <div className="section-head">
              <h2 className="h2">{t("Ask it things like")}</h2>
              <span className="eyebrow">
                {examTotals && examTotals.pos_total > 0 ? (
                  <>
                    {markup(t("answers <0/>/<1/> on its latest exam"), [
                      examTotals.pos_passed,
                      examTotals.pos_total,
                    ])}
                    {examTotals.neg_total > 0 &&
                      markup(t(" · anti-bluff <0/>/<1/>"), [
                        examTotals.neg_passed,
                        examTotals.neg_total,
                      ])}
                  </>
                ) : (
                  t("passed on its latest exam — graded, not claimed")
                )}
              </span>
            </div>
            <div className="rows">
              {passedChecks.map((c) => (
                <div key={c.question} className="row">
                  <span style={{ minWidth: 0 }}>
                    <strong>{c.question}</strong>
                    <span className="row-meta">{c.category}</span>
                  </span>
                  <span className="row-side" style={{ color: "var(--color-riso-green)" }}>
                    ✓
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {taught.length > 0 && (
          <section style={{ margin: "0 0 2.5rem" }}>
            <div className="section-head">
              <h2 className="h2">{t("Taught by agents")}</h2>
              <span className="eyebrow">{t("attribution from the grader, not copy")}</span>
            </div>
            <div className="rows" style={{ maxWidth: "44rem" }}>
              {/* `a`, not `t` — the callback parameter used to be named t and
                  shadowed the translator, which typechecks as "AgentTaught has
                  no call signatures" and is a confusing way to learn it. */}
              {taught.map((a) => (
                <div key={a.client} className="row">
                  <span style={{ minWidth: 0 }}>
                    <strong className="mono" style={{ fontSize: ".875rem" }}>{a.client}</strong>
                    <span className="row-sub">
                      {/* Singular and plural are two whole sentences, chosen
                          before translation — a plural suffix in a slot is an
                          English grammar rule the other ten languages do not
                          have. */}
                      {markup(
                        a.notes === 1
                          ? t("<0/> note written back while working")
                          : t("<0/> notes written back while working"),
                        [a.notes],
                      )}
                      {a.citedTotal > 0 &&
                        markup(t(" · evidence in <0/> of <1/> examined answers"), [
                          a.citedPass,
                          a.citedTotal,
                        ])}</span>
                  </span>
                  {a.citedTotal > 0 && (
                    <span className="row-side mono" style={{ color: "var(--color-riso-green)" }}>
                      {Math.round((100 * a.citedPass) / a.citedTotal)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {children.length > 0 && (
          <section style={{ margin: "0 0 2.5rem" }}>
            <div className="section-head">
              <h2 className="h2">{t("What is inside")}</h2>
              <span className="eyebrow">
                {markup(t("asking this brain searches all <0/>"), [
                children.length,
              ])}</span>
            </div>
            <div className="rows">
              {children.map((c) => (
                <Link key={c.id} className="row" href={`/b/${handle}/${c.slug}`}>
                  <span style={{ minWidth: 0 }}>
                    <strong>{c.title}</strong>
                    <span className="row-sub">{c.goal ?? t("No goal set.")}</span>
                    <span className="row-meta">{markup(t("<0/> notes"), [
                      c.note_count,
                    ])}</span>
                  </span>
                  <span className="row-side">
                    {c.score === null ? "—" : `${c.score}%`}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div
          style={{
            display: "grid",
            gap: "1.5rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            alignItems: "start",
          }}
        >
          <section className="scorecard">
            <div className="score-head">
              <div>
                <p className="eyebrow" style={{ marginBottom: ".35rem" }}>
                  {t("What it can answer")}</p>
                <span className="mono" style={{ fontSize: ".8125rem", color: "var(--ink-2)" }}>
                  {/* Coverage only. The trend below counts the whole exam,
                      anti-bluff probes included, which is what the percentage
                      is computed over — so the two numbers differ and each
                      has to say which it is. */}
                  {categories.length
                    ? fill(t("<0/> coverage checks"), [
                        categories.reduce((n, c) => n + c.total, 0),
                      ])
                    : t("not examined")}
                </span>
              </div>
              {brain.score !== null && (
                <div className="score-big">
                  {brain.score}
                  <sup>%</sup>
                </div>
              )}
            </div>

            {/* The percentage on its own reads as a verdict on the brain, and
                it is not one: the exam grows, so a brain that learned can post
                a smaller number. The absolute count and the split below are
                what the percentage is usually mistaken for. */}
            {trend && (
              <div
                style={{
                  padding: ".85rem 1.25rem",
                  borderTop: "1.5px solid var(--ink)",
                  display: "grid",
                  gap: ".3rem",
                }}
              >
                <span className="mono" style={{ fontSize: ".8125rem" }}>
                  {markup(t("Answers <0/> of the exam's <1/> questions"), [
                    <strong key="s0">{trend.passed}</strong>,
                    trend.total,
                  ])}
                </span>
                {trendLine(trend) && (
                  <span
                    className="mono"
                    style={{ fontSize: ".75rem", color: "var(--ink-2)" }}
                  >
                    {markup(t(trendLine(trend)!.key), trendLine(trend)!.values)}
                  </span>
                )}
                {/* Honesty, next to coverage and never folded into it. A
                    reader deciding whether to point an agent at this brain
                    cares more about what it does at its edges than about the
                    percentage: a brain that answers 90% and bluffs the rest
                    is worse to automate against than one that answers 70%
                    and says so. Silent when the sitting had no probes — the
                    maintenance pass tops those up, and "0 of 0" would read
                    as a perfect record. */}
                {trend.bluff.probes > 0 && (
                  <span
                    className="mono"
                    style={{ fontSize: ".75rem", color: "var(--ink-2)" }}
                  >
                    {markup(t("Admits it does not cover <0/> of <1/> out-of-scope questions"), [
                      <strong key="b0">{trend.bluff.refused}</strong>,
                      trend.bluff.probes,
                    ])}
                  </span>
                )}
                {trend.regressed === 0 && trend.unanswered > 0 && (
                  <span
                    className="mono"
                    style={{ fontSize: ".75rem", color: "var(--color-riso-green)" }}
                  >
                    {t("Nothing it used to answer has stopped working.")}
                  </span>
                )}
              </div>
            )}

            {categories.length === 0 ? (
              <p style={{ padding: "1.25rem", margin: 0, color: "var(--ink-2)" }}>
                {t("This brain has not sat its exam yet, so its coverage is unverified.")}</p>
            ) : (
              categories.map((c) => (
                <div key={c.category} className="score-row" data-state={c.state}>
                  <span className="sig">{STATE_SIGIL[c.state]}</span>
                  <span>{c.category}</span>
                  <span className="count">
                    {c.passed} / {c.total}
                  </span>
                </div>
              ))
            )}

            {brain.visibility === "public" && brain.score !== null && (
              <div style={{ padding: ".9rem 1.25rem", borderTop: "1.5px solid var(--ink)" }}>
                <Link className="navlink" href={`/b/${handle}/${brain.slug}/badge`}>
                  {t("exam badge — share this score →")}</Link>
              </div>
            )}
          </section>
        </div>

        {redteam.length > 0 && (
          <section style={{ marginTop: "2.5rem" }}>
            <div className="section-head">
              <h2 className="h2">{t("Attacks survived")}</h2>
              <span className="eyebrow">{markup(t("re-run weekly · <0/>"), [
                redteam[0].ran,
              ])}</span>
            </div>
            <div className="rows" style={{ maxWidth: "52rem" }}>
              {redteam.map((r) => (
                <div key={r.attack} className="row" data-tint={r.survived ? undefined : "red"}>
                  <span style={{ minWidth: 0 }}>
                    <strong className="mono" style={{ fontSize: ".875rem" }}>
                      <span style={{ color: r.survived ? "var(--color-riso-green)" : "var(--color-riso-red)", marginRight: ".5rem" }}>
                        {r.survived ? "✓" : "✕"}
                      </span>
                      {r.attack}
                    </strong>
                    <span className="row-sub">{r.detail}</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="mono" style={{ fontSize: ".6875rem", color: "var(--ink-3)", marginTop: ".5rem" }}>
              {t("heuristic scans against known attack classes — measured and dated, not a promise of unpoisonability")}</p>
          </section>
        )}

        <section style={{ marginTop: "3rem", display: "grid", gap: "2rem", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div>
            <h2 className="h2" style={{ marginBottom: "1rem" }}>
              {preview ? t("What is inside") : t("Inside")}
            </h2>
            {preview && (
              <p style={{ color: "var(--ink-2)", marginTop: 0, fontSize: ".9375rem" }}>
                {t("Note titles, so you can judge before you buy. The contents unlock on purchase.")}</p>
            )}
            <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--ink-2)", display: "grid", gap: ".35rem" }}>
              {samples.map((s) => (
                <li key={s.title}>
                  {s.title}
                  {s.category && (
                    <span className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)" }}>
                      {" "}
                      · {s.category}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="h2" style={{ marginBottom: "1rem" }}>
              {t("Licence")}</h2>
            <p className="tag" style={{ display: "inline-block", marginBottom: ".75rem" }}>
              {t(licence.label)}
            </p>
            <p style={{ color: "var(--ink-2)", margin: 0 }}>{t(licence.detail)}</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
