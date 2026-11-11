import Link from "next/link";
import { translator } from "@/lib/t";

/** SVOD stage 7: private base — no public catalogue navigation. */
export default async function Contents({ active }: { active?: string }) {
  const t = await translator();

  return (
    <nav className="contents" aria-label={t("Pages")}>
      <div className="shell contents-inner">
        <Link
          href="/connect"
          className="nav-flat"
          data-active={active === "/connect"}
        >
          <span className="nav-label">{t("Connect")}</span>
          <span className="nav-summary-note">{t("MCP setup")}</span>
        </Link>
      </div>
    </nav>
  );
}
