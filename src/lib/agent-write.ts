import { one } from "@/db";
import type { Brain } from "@/db/types";
import type { Access } from "@/lib/access";
import type { DuplicateMatch } from "@/lib/dedup";
import { rateLimited } from "@/lib/rate-limit";
import { scanInjection, scanSecrets } from "@/lib/scan";
import { normalizeCategory } from "@/lib/category";
import { noteWarnings, type NoteWarning } from "@/lib/note-quality";
import { isUuid } from "@/lib/svod-folders";

/**
 * The agent-note write pipeline, shared by every path an agent can teach
 * through: the MCP tools (brain_write, brain_write_batch) and the HTTP
 * endpoint (POST /api/brains/[id]/notes). Three doors, one pipeline — a gate
 * enforced in one path and not the next is how a secret scan gets skipped.
 *
 * SVOD stage 4: proposals only (see header). No embed service, no paid LLM.
 */

/**
 * The agent-note write pipeline, shared by every path an agent can teach
 * through: the MCP tools (brain_write, brain_write_batch) and the HTTP
 * endpoint (POST /api/brains/[id]/notes). Three doors, one pipeline — a gate
 * enforced in one path and not the next is how a secret scan gets skipped.
 */

/** Notes per batch call. Matches the url cap on brain_add_source. */
export const MAX_BATCH_NOTES = 25;

/**
 * Proposals per hour, per reader, per brain — enforced at every door.
 *
 * A review queue is a person, and a person who opens theirs to two hundred
 * machine-written notes closes it for good. The other limits in front of these
 * endpoints protect the platform's bill; this one protects the owner's
 * attention, which is the scarcer resource.
 */
export const PROPOSALS_PER_HOUR = 20;

/**
 * Take one unit of that budget, or report it spent.
 *
 * Counted per note rather than per call, deliberately: a batch holds
 * twenty-five, so charging the batch once would have let one reader put five
 * hundred notes an hour in front of an owner while staying inside a limit
 * named "twenty".
 */
export async function proposalAllowed(userId: string, brainId: string): Promise<boolean> {
  return !(await rateLimited(userId, `propose:${brainId}`, PROPOSALS_PER_HOUR));
}

export interface AgentNoteInput {
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  category?: unknown;
  folder_id?: unknown;
  folder?: unknown;
  /** Ignored: tokens cannot force active via input (stage 4). */
  status?: unknown;
  pending?: unknown;
}

export type WriteNoteResult =
  | {
      status: "saved";
      title: string;
      pending: boolean;
      /** Set when the note went to review and resembles an existing one. */
      lookalike: DuplicateMatch | null;
      /** Quality hints — never a reason it was refused. See lib/note-quality.ts. */
      warnings: NoteWarning[];
    }
  | { status: "duplicate"; title: string; existing: DuplicateMatch }
  | { status: "rejected"; title: string; reason: string };

/**
 * review_required is the owner's protection against outside writers. The
 * owner teaching their own brain through their own token needs no review —
 * their notes activate inline regardless of the flag. Grantees still pend.
 */
export function writeNeedsReview(brain: Brain, access: Access): boolean {
  return brain.review_required && access !== "owner";
}

/**
 * Save one agent-authored note. Access and plan checks belong to the caller —
 * they differ per door (MCP resolves by handle, HTTP by id); everything from
 * validation down to activation is identical and lives here.
 *
 * SVOD stage 4: proposals only. Every agent write through this pipeline lands
 * pending and attributed (user + token), whoever the caller is — owner,
 * editor or reader. Nothing an agent stores here becomes searchable without a
 * reviewer approving it (see svod-proposals approveProposal). Direct project
 * writes use the trusted distinct path (svod-notes createProjectNoteDirect /
 * updateProjectNoteDirect), never this helper.
 *
 * No eager embedding / paid LLM / old extraction on save: pending proposals
 * get no chunks and no vectors. The reviewer is the dedup backstop. Token
 * input cannot force active: pending is by construction from opts, never from
 * caller input (input.status is ignored).
 */
/**
 * A searchable title out of the text itself: the first sentence, clipped to
 * something a person would scan in a list. Not clever — a note titled by its
 * own opening line is exactly what a human writing in a hurry produces.
 */
export function firstSentenceForTest(text: string): string {
  return firstSentence(text);
}

function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  const first = (end > 0 ? text.slice(0, end) : text).trim();
  return (first.length > 100 ? `${first.slice(0, 97)}…` : first) || text.slice(0, 100);
}

export async function writeAgentNote(
  brain: Brain,
  opts: {
    pending: boolean;
    agentClient: string;
    /**
     * Set when the writer is a reader rather than an owner or contributor —
     * the note is a proposal. Recorded on the row so the review screen can
     * show whose it is and how their earlier ones turned out.
     */
    proposedBy?: string | null;
    /** Source token attribution (survives soft revocation). */
    tokenId?: string | null;
    folderId?: string | null;
  },
  input: AgentNoteInput,
): Promise<WriteNoteResult> {
  // Preserve the original body literally (BOM/CRLF/whitespace/fences): never
  // trim or slice before validation. Titles are validated (not silently
  // sliced) via the shared validator; oversize is a visible rejection.
  const { validateNoteBody, validateNoteTitle } = await import("@/lib/svod-notes");
  const rawTitleInput = typeof input.title === "string" ? input.title : String(input.title ?? "");
  let titleCandidate = rawTitleInput;
  let bodyCandidate = typeof input.body === "string" ? input.body : String(input.body ?? "");

  // Title-only compatibility fallback: a note sent as one field is still a
  // note. The body stays literal (the supplied title string verbatim); the
  // title becomes its first sentence. Body-when-supplied stays literal too.
  const titleSupplied = rawTitleInput.trim() !== "";
  const bodySupplied = bodyCandidate.replace(/\s/g, "") !== "";
  if (titleSupplied && !bodySupplied) {
    bodyCandidate = rawTitleInput;
    titleCandidate = firstSentence(rawTitleInput);
  } else if (!titleSupplied && bodySupplied) {
    titleCandidate = firstSentence(bodyCandidate);
  }

  const tv = validateNoteTitle(titleCandidate);
  if (!tv.ok) return { status: "rejected", title: titleCandidate.trim().slice(0, 200), reason: tv.error };
  const bv = validateNoteBody(bodyCandidate);
  if (!bv.ok) return { status: "rejected", title: tv.title, reason: bv.error };
  const title = tv.title;
  const body = bv.body;

  // Same gate as ingest. An agent paraphrasing a token into a "lesson" is a
  // real failure mode, and this is the path with no human in the loop.
  const findings = scanSecrets(`${title}\n${body}`);
  if (findings.length) {
    return {
      status: "rejected",
      title,
      reason:
        "Rejected: this looks like it contains a credential " +
        `(${findings.map((f) => f.label).join(", ")}). Rewrite it without the secret.`,
    };
  }

  // A proposal is text a stranger is putting in front of somebody else's
  // agents. "Ignore your previous instructions" in a note is not a bad note,
  // it is an attack on every reader of the brain — and the owner reviewing it
  // is reading with human eyes, which is precisely the wrong detector for a
  // string aimed at a model. Publication already runs this scan; the door a
  // stranger writes through needs it more.
  if (opts.proposedBy) {
    const steering = scanInjection(`${title}\n${body}`);
    if (steering.length) {
      return {
        status: "rejected",
        title,
        reason:
          "Rejected: this reads as an instruction to whoever's model loads it " +
          `(${[...new Set(steering.map((s) => s.label))].join(", ")}), not as a fact ` +
          "about the subject. Write what is true, not what the reader should do.",
      };
    }
  }

  // Pending by construction, not by the caller remembering to ask for it. The
  // gate that must never be bypassed belongs next to the insert it protects,
  // not in each of the three doors that reach it. Stage 4: always pending
  // through this helper (direct writes use the distinct project path).
  // input.status/pending is ignored — a token cannot force active via input.
  const pending = true;
  void opts.pending;

  // Optional folder (compatible args: folder_id or folder). Validated
  // same-base at the SQL boundary by the insert trigger; malformed IDs are
  // denial, not a 22P02.
  const rawFolder =
    typeof input.folder_id === "string"
      ? input.folder_id.trim()
      : typeof input.folder === "string"
        ? input.folder.trim()
        : typeof opts.folderId === "string"
          ? opts.folderId.trim()
          : "";
  const folderId = rawFolder || null;
  if (folderId && !isUuid(folderId)) {
    return { status: "rejected", title, reason: "Folder is in another base." };
  }

  // Stage 4: no eager embedding / paid LLM / old extraction on proposal save.
  // Pending proposals get no chunks and no duplicate-vector check; the
  // reviewer is the dedup backstop. lookalike stays null (reviewer sees both
  // on approval).
  const { folderInBrain } = await import("@/lib/svod-folders");
  if (folderId) {
    const f = await folderInBrain(folderId, brain.id);
    if (!f) return { status: "rejected", title, reason: "Folder is in another base." };
  }

  await one<{ id: string }>(
    `insert into notes
       (brain_id, folder_id, title, body, category, kind, author, agent_client, status,
        confidence, proposed_by, token_id)
     values ($1, $2, $3, $4, $5, $6, 'agent', $7, 'pending', 0.7, $8, $9)
     returning id`,
    [
      brain.id,
      folderId,
      title,
      body,
      // Same canonicalisation ingest applies — an agent writing "Type Scale"
      // must land in the same category as extraction's "type scale".
      normalizeCategory(typeof input.category === "string" ? input.category : null),
      typeof input.kind === "string" ? input.kind : "fact",
      opts.agentClient,
      opts.proposedBy ?? null,
      opts.tokenId ?? null,
    ],
  );

  // Pending notes stay unindexed until approved — otherwise "review required"
  // would be theatre and unapproved notes would already be answering queries.

  return {
    status: "saved",
    title,
    pending,
    lookalike: null,
    // Computed after the note is safely stored, never before: a quality hint
    // must not be able to cost somebody the note it was hinting about.
    warnings: noteWarnings(title, body, typeof input.kind === "string" ? input.kind : "fact"),
  };
}
