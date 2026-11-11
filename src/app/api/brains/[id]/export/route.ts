import { NextResponse } from "next/server";
import { query } from "@/db";
import type { Note } from "@/db/types";
import { brainAccessById } from "@/lib/svod-access";
import { requireUser } from "@/lib/session";

/**
 * SVOD workspace export: active notes as Markdown.
 * Gated by role only — no licence, plan or billing gate.
 */

const PRECEDENCE =
  "> **This is a snapshot.** It was correct on the day it was exported and has " +
  "no way of noticing that it is not any more. If the mozg MCP server is " +
  "connected in this session, search the live brain instead and use this file " +
  "only as a fallback: the brain is re-read when its sources change and re-sat " +
  "against its own exam, and it can tell you what it does *not* know. Where the " +
  "two disagree, the brain is newer.\n\n";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const found = await brainAccessById(id, user.id);
  // Unknown and ungranted are the same 404: a forged ID must not reveal
  // whether the base exists.
  if (!found?.canRead) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { brain } = found;
  const format = new URL(req.url).searchParams.get("format") ?? "claude";

  const notes = await query<Note>(
    `select * from notes where brain_id = $1 and status = 'active'
      order by category nulls last, created_at`,
    [brain.id],
  );

  const byCategory = new Map<string, Note[]>();
  for (const note of notes) {
    const key = note.category ?? "General";
    byCategory.set(key, [...(byCategory.get(key) ?? []), note]);
  }

  const sections = [...byCategory.entries()]
    .map(
      ([category, list]) =>
        `## ${category}\n\n` +
        list.map((n) => `### ${n.title}\n\n${n.body}`).join("\n\n"),
    )
    .join("\n\n");

  const header =
    `# ${brain.title}\n\n` +
    (brain.goal ? `${brain.goal}\n\n` : "") +
    `${notes.length} notes` +
    (brain.score !== null ? ` · exam score ${brain.score}%` : "") +
    `\n\nExported from svod on ${new Date().toISOString().slice(0, 10)}.\n`;

  const trigger = brain.goal?.trim()
    ? brain.goal.trim().replace(/\s+/g, " ")
    : `Project knowledge about ${brain.title}.`;

  const { body, filename } = render(format, brain.slug, header, sections, trigger);

  return new NextResponse(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

function render(
  format: string,
  slug: string,
  header: string,
  sections: string,
  trigger: string,
) {
  switch (format) {
    case "skill":
      return {
        filename: `svod-${slug}-skill.md`,
        body:
          `---\nname: svod-${slug}\ndescription: >-\n  ${trigger} ` +
          `Use when the task depends on these project-specific conventions. ` +
          `Superseded by the live brain: if the MCP server is ` +
          `connected, prefer brain_search on ${slug}.\n---\n\n` +
          PRECEDENCE +
          `${header}\n${sections}\n`,
      };

    case "agents":
      return {
        filename: "AGENTS.md",
        body: PRECEDENCE + `${header}\n${sections}\n`,
      };

    default:
      return {
        filename: "CLAUDE.md",
        body: PRECEDENCE + `${header}\n${sections}\n`,
      };
  }
}
