"use client";

import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useT } from "@/lib/t-client";
import { fill } from "@/lib/markup";

/**
 * SVOD stage 3 single shared Markdown reader + preview.
 *
 * One component, used by the workspace reader (server) and the editor live
 * preview (client). React elements, never dangerouslySetInnerHTML. No
 * rehype-raw, so raw HTML in a note is inert text — an inline handler in the
 * source cannot become a handler in the DOM. Relative links (guide.md,
 * ../guide.md#part) are preserved as written; only unsafe schemes render as
 * plain text. Remote images never load: `img` renders as an inert label.
 */

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

/** Mirrors react-markdown's defaultUrlTransform: relative links pass through
 *  untouched; only an explicit unsafe scheme is blocked. No https-prepending,
 *  no length truncation — the URL is preserved as the author wrote it. */
function isSafeHref(url: string): boolean {
  const v = url.trim();
  if (!v) return false;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
  if (!m) return true;
  return ALLOWED_SCHEMES.has(m[1].toLowerCase());
}

function SvodMarkdown({ body }: { body: string }) {
  const t = useT();
  return (
    <div className="svod-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={defaultUrlTransform}
        components={{
          a({ href, children }: { href?: string; children?: React.ReactNode }) {
            const raw = String(href ?? "");
            if (!isSafeHref(raw)) return <span>{children}</span>;
            const external = /^(https?:|mailto:)/i.test(raw.trim());
            return external ? (
              <a href={raw} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <a href={raw}>{children}</a>
            );
          },
          // Remote images never load as part of note viewing: inert label instead.
          img({ alt }: { alt?: string }) {
            return (
              <span className="svod-md-img">{fill(t("[image<0/>]"), [alt ? `: ${alt}` : ""])}</span>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export default memo(SvodMarkdown);
