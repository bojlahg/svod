import { translator } from "@/lib/t";
import Link from "next/link";

/** SVOD stage 7: private base — footer without catalogue or marketing links. */
export default async function SiteFooter() {
  const t = await translator();

  return (
    <footer style={{ borderTop: "1px solid var(--rule)", marginTop: "clamp(4rem, 9vw, 6rem)" }}>
      <div
        className="shell"
        style={{
          paddingBlock: "clamp(2rem, 5vw, 3rem)",
          display: "flex",
          gap: "1.5rem",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Link href="/" className="wordmark" style={{ fontSize: "1.25rem" }}>
          {t("svod.")}
        </Link>
        <span style={{ color: "var(--ink-2)", fontSize: ".9375rem" }}>
          {t("Private local base.")}
        </span>
        <span style={{ flex: 1 }} />
        <Link href="/brains" style={{ color: "var(--ink-2)", fontSize: ".9375rem" }}>
          {t("Your bases")}
        </Link>
        <Link href="/settings/tokens" style={{ color: "var(--ink-2)", fontSize: ".9375rem" }}>
          {t("Tokens")}
        </Link>
        <Link href="/connect" style={{ color: "var(--ink-2)", fontSize: ".9375rem" }}>
          {t("Connect")}
        </Link>
      </div>
    </footer>
  );
}
