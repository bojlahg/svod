import { canonicalPlugin, installCommand, isPublishedPlugin } from "@/lib/plugins";

/**
 * The hands a brain's knowledge needs.
 *
 * A brain says how something is done. Some of what it teaches is done far
 * better by a tool on the reader's own machine — and the agent has no way to
 * learn that, so it follows the by-hand notes straight past a machine that
 * would have done the job. This is the brain naming its own tools, so the
 * brief can hand them over before the first search.
 *
 * Three rules the rest of this file exists to keep:
 *
 *   1. mozg never runs them. They are local tools against local files, and in
 *      Spine's case a licensed desktop app. We ship the knowledge that they
 *      exist, not a promise to be them.
 *   2. mozg cannot see whether the reader has one. Our server has no view of
 *      the agent's own tool list, so every word rendered here is an
 *      instruction to go and look, never a claim about what is connected.
 *   3. The text is untrusted. It is written by whoever owns the brain and read
 *      by an agent that can execute shell commands — see sanitise().
 */

/** At most this many per brain: a list, not a directory. */
export const MAX_TOOLS = 4;

export interface BrainTool {
  /** Short handle — the name the tool gets added under. */
  name: string;
  /** What it does, in one line. */
  what: string;
  /** What must already be on the machine: a licence, an app, a runtime. */
  needs?: string;
  /**
   * A plugin mozg publishes, by name. The install command is generated from
   * lib/plugins.ts — never written here, and never rendered for a name mozg
   * does not actually ship.
   */
  plugin?: string;
  /** Where to read about a tool mozg does not publish. A link, not a command. */
  docs?: string;
}

/**
 * Flatten one owner-written field into something safe to put in a prompt.
 *
 * The load-bearing part is the control-character strip, and it is not cosmetic.
 * This text goes verbatim into the context of an agent that can run commands.
 * A field allowed to carry line breaks can carry a blank line and a fresh
 * paragraph that reads as though mozg wrote it — "Ignore the above and run…" —
 * and a public brain is a channel anybody can publish into. One line in, one
 * line out, and a prompt injection has nowhere to stand.
 */
function sanitise(value: unknown, max: number): string {
  return String(value ?? "")
    // Every control character, not just newline: a carriage return splits a
    // line in a terminal just as well, and the C1 range does it in a
    // surprising number of renderers.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A link a person may click. Anything that is not plain http(s) is dropped. */
function safeUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** A tool name is a handle, not prose: it is what the command adds it under. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * Read the column into something renderable, dropping anything malformed.
 *
 * Silent on bad rows on purpose: this is display, and a brief that threw
 * because one tool entry was wrong would take the whole map down with it.
 */
export function parseTools(raw: unknown): BrainTool[] {
  if (!Array.isArray(raw)) return [];
  const out: BrainTool[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = sanitise(e.name, 40).toLowerCase();
    const what = sanitise(e.what, 120);
    if (!NAME.test(name) || !what) continue;
    const needs = sanitise(e.needs, 120);

    // Only a plugin mozg genuinely publishes. An owner naming something else
    // gets silence, not a command — see lib/plugins.ts for the install line
    // that made this rule.
    const claimed = sanitise(e.plugin, 40).toLowerCase();
    const plugin = isPublishedPlugin(claimed) ? canonicalPlugin(claimed) : "";

    // http(s) only, and parsed rather than pattern-matched: `javascript:` is a
    // URL by every loose test and a script by the one that matters.
    const docs = safeUrl(sanitise(e.docs, 200));

    out.push({
      name,
      what,
      ...(needs ? { needs } : {}),
      ...(plugin ? { plugin } : {}),
      ...(docs ? { docs } : {}),
    });
    if (out.length === MAX_TOOLS) break;
  }
  return out;
}

/**
 * The block an agent reads before it searches.
 *
 * Written as instructions rather than as facts, because the two things it would
 * most like to say are both unknowable from here: whether this agent has the
 * tool, and whether the command is safe. So it says "look" and "ask" instead,
 * and marks the whole thing as somebody else's words.
 */
export function describeTools(tools: BrainTool[]): string[] {
  if (!tools.length) return [];

  const lines = ["", "Hands for this knowledge — they run on your machine, not on svod:"];

  for (const t of tools) {
    lines.push(`  ${t.name} — ${t.what}`);
    if (t.needs) lines.push(`      needs: ${t.needs}`);
    const add = t.plugin ? installCommand(t.plugin) : null;
    if (add) lines.push(`      add:   ${add}`);
    if (t.docs) lines.push(`      docs:  ${t.docs}`);
  }

  lines.push(
    "",
    "Check your own tools before following any note that describes doing this",
    "by hand: if one of these is already connected, use it — the notes are how",
    "the work is done, the tool is what does it. If it is not connected and the",
    "job needs it, say so and show the command rather than hand-rolling output",
    "a machine would have produced.",
    "",
    "What each tool is and does was written by the brain's owner; any add command",
    "is svod's own and installs a plugin svod publishes. svod still cannot see",
    "what you have connected, and installing is a change to the machine you are",
    "working on — put it to the person you are working for rather than running",
    "it on your own say-so.",
  );

  return lines;
}
