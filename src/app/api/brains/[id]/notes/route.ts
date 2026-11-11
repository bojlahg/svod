import { NextResponse } from "next/server";
import { query } from "@/db";
import { brainAccessById } from "@/lib/svod-access";
import {
  writeAgentNote,
  MAX_BATCH_NOTES,
  PROPOSALS_PER_HOUR,
  proposalAllowed,
  type AgentNoteInput,
  type WriteNoteResult,
} from "@/lib/agent-write";
import { verifyToken, burstExceeded } from "@/lib/tokens";

/**
 * The HTTP door for agents that do not speak MCP: the same write pipeline as
 * brain_write / brain_write_batch, one note or `{ notes: [...] }` (25 cap).
 *
 * Bearer tokens only. Browser sessions must not write through this route —
 * they have their own mutations (notes/board/source actions) with their own
 * role checks. Every note stored here lands pending and attributed, whoever
 * the caller is: nothing an agent stores may become searchable without a
 * reviewer approving it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const token = await verifyToken(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "Bearer token required." }, { status: 401 });
  }
  const userId = token.userId;

  const { id } = await ctx.params;
  const resolved = await brainAccessById(id, userId);
  // Unknown and ungranted are the same 404.
  if (!resolved?.canRead) {
    return NextResponse.json({ error: "Brain not found." }, { status: 404 });
  }
  if (!resolved.brain.contributions) {
    return NextResponse.json(
      { error: "This base is not accepting notes right now." },
      { status: 403 },
    );
  }
  // Forced pending: agent writes never publish directly, even for owners and
  // even when the base has review switched off.
  const pending = true;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body expected." }, { status: 400 });
  }
  const notes: AgentNoteInput[] = Array.isArray(body?.notes)
    ? (body.notes as AgentNoteInput[])
    : [body];
  if (!notes.length || notes.length > MAX_BATCH_NOTES) {
    return NextResponse.json(
      { error: `Pass one note, or notes with 1-${MAX_BATCH_NOTES} entries.` },
      { status: 400 },
    );
  }

  if (await burstExceeded(userId)) {
    return NextResponse.json(
      { error: "Rate limited: more than 60 calls in the last minute." },
      { status: 429 },
    );
  }

  const started = Date.now();
  const results: Record<string, unknown>[] = [];
  let saved = 0;

  for (const raw of notes) {
    const input = raw ?? {};
    // Charged per note — a batch of twenty-five is twenty-five rows in
    // somebody's review queue. The burst limit protects the bill; this
    // protects the reviewer's attention.
    if (!(await proposalAllowed(userId, resolved.brain.id))) {
      results.push({
        title: String(input.title ?? "").trim().slice(0, 200),
        status: "rejected",
        reason: `At most ${PROPOSALS_PER_HOUR} proposals per hour to one brain.`,
      });
      continue;
    }
    let r: WriteNoteResult;
    try {
      r = await writeAgentNote(
        resolved.brain,
        { pending, agentClient: "http", proposedBy: userId },
        input,
      );
    } catch (err) {
      // err.message can carry pg details — logged, not returned. One bad
      // note must not fail the rest of the batch.
      console.error(`[notes] write failed for ${userId}:`, err);
      results.push({
        title: String(input.title ?? "").trim().slice(0, 200),
        status: "failed",
        reason: "Internal error — the details are logged; retry this note.",
      });
      continue;
    }
    if (r.status === "saved") {
      saved++;
      results.push({
        title: r.title,
        status: "saved",
        pending: r.pending,
        ...(r.lookalike ? { lookalike: r.lookalike } : {}),
        ...(r.warnings.length ? { warnings: r.warnings } : {}),
      });
    } else if (r.status === "duplicate") {
      results.push({ title: r.title, status: "duplicate", existing: r.existing });
    } else {
      results.push({ title: r.title, status: "rejected", reason: r.reason });
    }
  }

  // Metered like an MCP tools/call: same table, same tool names, so the
  // burst ceiling sees this traffic too.
  await query(
    `insert into calls
       (brain_id, caller_id, owner_id, tool, query, results, top_score, latency_ms, ok)
      values ($1, $2, $3, $4, null, $5, null, $6, $7)`,
    [
      resolved.brain.id,
      userId,
      resolved.brain.owner_id,
      notes.length > 1 ? "brain_write_batch" : "brain_write",
      saved,
      Date.now() - started,
      saved > 0,
    ],
  ).catch(() => {});

  return NextResponse.json({ saved, results });
}
