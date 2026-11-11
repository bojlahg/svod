import { translator } from "@/lib/t";
import { ImageResponse } from "next/og";
import type { Brain } from "@/db/types";
import { tintFor } from "@/lib/brains";

/**
 * The share card for a public brain. Same riso print language as the site:
 * paper, ink, one block of process colour, the exam score doing the talking.
 * No custom fonts — the default fallback covers Cyrillic, which brain titles
 * carry.
 */

// The card is drawn per brain from the database, so there is nothing to
// collect at build time — and trying to collect it fails in the container,
// which has no credentials and should not need any to compile.
export const dynamic = "force-dynamic";

export const alt = "A mozg brain — exam score and note count";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#eceee7";
const PAPER2 = "#f6f7f3";
const INK = "#14161a";
const INK2 = "#565c66";
const RULE = "#cfd2ca";

const RISO: Record<string, string> = {
  blue: "#3d5588",
  red: "#f15060",
  green: "#00a95c",
  yellow: "#ffe800",
  violet: "#765ba7",
  orange: "#ff6c2f",
};

export default async function OgImage({
  params,
}: {
  params: Promise<{ handle: string; slug: string }>;
}) {
  const t = await translator();

  const { handle, slug } = await params;
  // SVOD: no public share cards. Only a caller who may read the base sees
  // its title — everyone else gets the generic card.
  let brain: Brain | null = null;
  try {
    const { currentUser } = await import("@/lib/session");
    const { brainAccessByHandleSlug } = await import("@/lib/svod-access");
    const user = await currentUser();
    if (user) {
      const found = await brainAccessByHandleSlug(handle, slug, user.id);
      brain = found?.canRead ? found.brain : null;
    }
  } catch {
    brain = null;
  }

  const tint = brain ? (RISO[tintFor(brain)] ?? RISO.blue) : RISO.blue;
  const onTint = tint === RISO.yellow || tint === RISO.orange ? INK : PAPER2;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: PAPER,
          border: `6px solid ${INK}`,
          padding: 64,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              width: 72,
              height: 72,
              background: tint,
              border: `3px solid ${INK}`,
              flexShrink: 0,
            }}
          />
          <div
            style={{
              display: "flex",
              fontSize: 28,
              letterSpacing: 4,
              textTransform: "uppercase",
              color: INK2,
            }}
          >
            {brain ? `mozg · ${handle}` : "mozg"}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 48,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, maxWidth: 720 }}>
            <div
              style={{
                display: "flex",
                fontSize: 64,
                fontWeight: 800,
                letterSpacing: -2,
                lineHeight: 1.05,
                color: INK,
                marginTop: 24,
              }}
            >
              {brain?.title ?? t("One brain, every agent")}
            </div>
            {brain?.goal && (
              <div
                style={{
                  display: "flex",
                  fontSize: 30,
                  color: INK2,
                  marginTop: 20,
                  maxWidth: 720,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {brain.goal}
              </div>
            )}
          </div>

          {brain?.score !== null && brain?.score !== undefined && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                background: tint,
                color: onTint,
                border: `4px solid ${INK}`,
                padding: "16px 32px",
                fontSize: 104,
                fontWeight: 800,
                letterSpacing: -4,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              {brain.score}
              <div style={{ display: "flex", fontSize: 48, marginLeft: 6 }}>%</div>
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: `2px solid ${RULE}`,
            paddingTop: 24,
            marginTop: 40,
            fontSize: 26,
            color: INK2,
          }}
        >
          <div style={{ display: "flex" }}>
            {brain
              ? `${brain.note_count} notes${
                  brain.score === null ? t(" · not examined yet") : t(" · exam score")
                }`
              : t("Build a knowledge brain, connect it over MCP.")}
          </div>
          <div style={{ display: "flex" }}>{t("one brain, every agent")}</div>
        </div>
      </div>
    ),
    size,
  );
}
