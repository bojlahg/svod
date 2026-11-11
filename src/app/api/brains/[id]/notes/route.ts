import { NextResponse } from "next/server";
import { query } from "@/db";
import { brainAccessById } from "@/lib/svod-access";
import { getTokenCapability } from "@/lib/svod-token-scopes";
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
 * The HTTP door for agents that do not speak MCP: proposals only, one note or
 * `{ notes: [...] }` (25 cap). New notes and existing-note edits (via
 * `target_note_id`) both land as token-attributed pending proposals — the
 * current accepted note stays unchanged and searchable until manual approval.
 *
 * Bearer tokens only with explicit grants (user ACL ∩ live token scope):
 * legacy unscoped tokens and OAuth fail closed with a transition hint.
 * Browser sessions must not write here — they have their own mutations.
 * Tokens cannot force active via input: `status`/`pending` fields are ignored,
 * every note here stays pending (direct project writes use the MCP
 * project_note_* path, a trusted distinct door).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const token = await verifyToken(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "Bearer token required." }, { status: 401 });
  }
  const userId = token.userId;

  const { id } = await ctx.params;
  const resolved = await brainAccessById(id, userId);
  // Unknown and ungranted are the same 404 (user half).
  if (!resolved?.canRead) {
    return NextResponse.json({ error: "Brain not found." }, { status: 404 });
  }
  // Token half: explicit propose (or write, which implies propose) required.
  const capability = await getTokenCapability(token.tokenId, resolved.brain.id);
  const canPropose = capability === "propose" || capability === "write";
  if (!canPropose) {
    return NextResponse.json(
      {
        error:
          "This token holds no propose grant on this base. Grant read+propose " +
          "(or read+direct-write on project bases) at /settings/tokens. " +
          "Legacy unscoped tokens and OAuth stay denied until they hold explicit grants.",
      },
      { status: 404 },
    );
  }
  if (!resolved.brain.contributions) {
    return NextResponse.json(
      { error: "This base is not accepting notes right now." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body expected." }, { status: 400 });
  }
  const notes: (AgentNoteInput & { target_note_id?: unknown; note_id?: unknown })[] = Array.isArray(
    body?.notes,
  )
    ? (body.notes as (AgentNoteInput & { target_note_id?: unknown; note_id?: unknown })[])
    : [body as AgentNoteInput & { target_note_id?: unknown; note_id?: unknown }];
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
    if (!(await proposalAllowed(userId, resolved.brain.id))) {
      results.push({
        title: String(input.title ?? "").trim().slice(0, 200),
        status: "rejected",
        reason: `At most ${PROPOSALS_PER_HOUR} proposals per hour to one brain.`,
      });
      continue;
    }
    // Edit proposals reference a target note UUID; new notes omit it.
    const targetRaw = String(
      (input as { target_note_id?: unknown; note_id?: unknown }).target_note_id ??
        (input as { target_note_id?: unknown; note_id?: unknown }).note_id ??
        "",
    ).trim();
    if (targetRaw) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetRaw)) {
        results.push({ title: String(input.title ?? "").trim().slice(0, 200), status: "rejected", reason: "target_note_id must be a note UUID." });
        continue;
      }
      try {
        const { proposeEditNote } = await import("@/lib/svod-proposals");
        const { validateNoteTitle, validateNoteBody } = await import("@/lib/svod-notes");
        const rawT = typeof input.title === "string" ? input.title : String(input.title ?? "");
        const rawB = typeof input.body === "string" ? input.body : String(input.body ?? "");
        const tv0 = validateNoteTitle(rawT.trim() !== "" ? rawT : "Untitled");
        if (!tv0.ok) {
          results.push({ title: rawT.trim().slice(0, 200), status: "rejected", reason: tv0.error });
          continue;
        }
        const bv0 = validateNoteBody(rawB);
        if (!bv0.ok) {
          results.push({ title: tv0.title, status: "rejected", reason: bv0.error });
          continue;
        }
        const proposal = await proposeEditNote({
          brainId: resolved.brain.id,
          targetNoteId: targetRaw,
          title: tv0.title,
          body: bv0.body,
          userId,
          tokenId: token.tokenId,
        });
        if (!proposal) {
          results.push({ title: tv0.title, status: "rejected", reason: "Target note not found." });
          continue;
        }
        saved++;
        results.push({ title: proposal.title, status: "saved", pending: true, proposal_id: proposal.id, target_note_id: targetRaw });
      } catch (err) {
        console.error(`[notes] edit proposal failed for ${userId}:`, err);
        results.push({
          title: String(input.title ?? "").trim().slice(0, 200),
          status: "failed",
          reason: "Internal error — the details are logged; retry this note.",
        });
      }
      continue;
    }
    let r: WriteNoteResult;
    try {
      // Forced pending: input.status/pending ignored — a token cannot force active.
      r = await writeAgentNote(
        resolved.brain,
        { pending: true, agentClient: "http", proposedBy: userId, tokenId: token.tokenId },
        input,
      );
    } catch (err) {
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
        ...(r.warnings.length ? { warnings: r.warnings } : {}),
      });
    } else if (r.status === "duplicate") {
      results.push({ title: r.title, status: "duplicate", existing: r.existing });
    } else {
      results.push({ title: r.title, status: "rejected", reason: r.reason });
    }
  }

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
