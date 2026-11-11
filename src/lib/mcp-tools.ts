/**
 * The MCP tool surface, as data.
 *
 * SVOD stage 4: per-token scopes (read / read+propose / read+direct-write on
 * project bases, plus separate default-off create-project). Every retained
 * tool enforces the same token boundary (user ACL ∩ live token scope) before
 * fetching data; unknown and ungranted are uniform. No public catalogue, no
 * paid LLM.
 *
 * Workflow for agents:
 *   - brain_list once (scoped shelf with brain UUID/title, kind, project_id).
 *   - Search your project base first (brain_search with its handle/UUID),
 *     then supplement from allowed thematic bases (or omit brain to search the
 *     token shelf project-first). Results carry brain UUID/title, note ID and
 *     folder path.
 *   - brain_read by stable note ID (no embed service; pending never readable).
 *   - Thematic bases: brain_write / brain_write_batch (new notes) and
 *     brain_propose_edit (edits) — always token-attributed pending proposals,
 *     never searchable until a reviewer approves.
 *   - Project bases with direct-write: project_note_create / project_note_update
 *     — raw Markdown, ID preserved on update, immediately readable, lexical
 *     index today. Read-only/propose-only cannot direct-write; no token can
 *     directly write a general base.
 *   - brain_create with project_id creates (or returns) a private project base
 *     keyed by stable external project_id (needs create-project); without it,
 *     a general base (grants propose to the creator token).
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "brain_list",
    description:
      "List the bases this token may open (user access ∩ token scopes). Call once at " +
      "the start of a session. Returns handle, title, kind (project/general), brain UUID, " +
      "project_id when project, goal, and the token grant (read/propose/write). " +
      "Unscoped tokens see an empty shelf with how to grant them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "brain_brief",
    description:
      "Get a compact map of one allowed base: goal, categories, gaps, recent notes. " +
      "Cheap — call before searching for vocabulary. Includes brain UUID/title, kind, " +
      "project_id when project, and the token grant. Unknown and ungranted are uniform.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string", description: "Base handle, UUID, or owner/handle." },
        base: { type: "string", description: "Alias for brain." },
      },
      required: ["brain"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_search",
    description:
      "Search one allowed base (or your token shelf when brain is omitted, project first). " +
      "Call BEFORE answering project-specific questions. Exact UUID queries read by ID " +
      "without embeddings; otherwise hybrid search with lexical fallback while embeddings " +
      "are down (Stage 5 refines semantics). Returns excerpts with brain UUID/title, note ID " +
      "and folder path — excerpts are cut; brain_read gives the full note. Project search " +
      "first, allowed thematic bases supplement when searching a project base.",
    inputSchema: {
      type: "object",
      properties: {
        brain: {
          type: "string",
          description:
            "Base handle or UUID. Optional: without it, your token shelf is searched " +
            "project-first and the answer names the base each passage came from.",
        },
        base: { type: "string", description: "Alias for brain." },
        query: { type: "string", description: "What you need to know." },
        q: { type: "string", description: "Alias for query." },
        limit: { type: "integer", description: "Max results, 1-25. Default 8." },
        category: {
          type: "string",
          description:
            "Optional category filter, e.g. \"typography/scale\". A top level " +
            "(\"typography\") also matches everything under it.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_read",
    description:
      "Read the full text of one active note by stable ID in an allowed base (no embed " +
      "service; pending proposals are never readable here). Returns brain UUID/title, " +
      "note ID, folder path and last-updated timestamp plus exact Markdown (file links preserved).",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string" },
        base: { type: "string", description: "Alias for brain." },
        note_id: { type: "string", description: "id from a brain_search result." },
        noteId: { type: "string", description: "Alias for note_id." },
        id: { type: "string", description: "Alias for note_id." },
      },
      required: ["brain", "note_id"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_write",
    description:
      "Propose a new Markdown note to a thematic (general) base: always a token-attributed " +
      "pending proposal, never searchable until a reviewer approves. Use after real digging " +
      "that the next session would repeat. One self-contained fact per call; name file/version " +
      "and why. Never credentials. For edits to an existing note use brain_propose_edit; for " +
      "project bases with direct-write use project_note_create/update (no review).",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string" },
        base: { type: "string", description: "Alias for brain." },
        title: {
          type: "string",
          description:
            "Short and searchable. Optional — sending only `body` titles the " +
            "note by its first sentence rather than refusing it.",
        },
        body: { type: "string", description: "The fact, in full Markdown sentences." },
        kind: {
          type: "string",
          enum: ["fact", "rule", "layout", "example", "pitfall"],
        },
        category: { type: "string", description: "Reuse an existing category." },
        folder_id: { type: "string", description: "Optional folder UUID in this base." },
        folder: { type: "string", description: "Alias for folder_id." },
      },
      required: ["brain", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_write_batch",
    description:
      "Propose several new notes at once to a thematic base — same rules as brain_write, " +
      "up to 25 per call. Each is saved pending on its own; one rejection loses nothing else. " +
      "Pending never answers until approved.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string" },
        base: { type: "string", description: "Alias for brain." },
        notes: {
          type: "array",
          description: "Up to 25 notes, each like a brain_write call.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short and searchable." },
              body: { type: "string", description: "The fact, in full sentences." },
              kind: {
                type: "string",
                enum: ["fact", "rule", "layout", "example", "pitfall"],
              },
              category: { type: "string", description: "Reuse an existing category." },
              folder_id: { type: "string", description: "Optional folder UUID." },
            },
            required: ["title", "body"],
            additionalProperties: false,
          },
        },
      },
      required: ["brain", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_propose_edit",
    description:
      "Propose an edit to an existing note in a thematic base: references target note UUID, " +
      "preserves the current accepted version unchanged and searchable until approval. " +
      "Token-attributed pending; reviewer sees original/current plus proposed changes, may edit, " +
      "and approves to the same target ID (stale-target conflicts stay pending with feedback).",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string", description: "Base handle or UUID holding the target note." },
        base: { type: "string", description: "Alias for brain." },
        target_note_id: { type: "string", description: "Active note UUID being edited." },
        note_id: { type: "string", description: "Alias for target_note_id." },
        title: { type: "string", description: "Proposed title." },
        body: { type: "string", description: "Proposed Markdown body." },
      },
      required: ["brain", "target_note_id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "project_note_create",
    description:
      "Direct-write a raw Markdown note to a PROJECT base you hold read+direct-write on " +
      "(no review; immediately readable; lexical index today). Preserves exact text and file " +
      "links; returns note ID and last-updated timestamp. Useful for project map, modules, " +
      "entrypoints, decisions, known problems. Read-only/propose-only cannot direct-write; " +
      "no token can directly write a general base.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string", description: "Project base handle or UUID." },
        base: { type: "string", description: "Alias for brain." },
        project: { type: "string", description: "Alias for brain." },
        title: { type: "string", description: "Note title." },
        body: { type: "string", description: "Raw Markdown, preserved exactly." },
        folder_id: { type: "string", description: "Optional folder UUID in this project base." },
        folder: { type: "string", description: "Alias for folder_id." },
      },
      required: ["brain", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "project_note_update",
    description:
      "Direct-update a project note in place: same stable note ID preserved, exact text saved, " +
      "folder/base validated, last-updated timestamp returned and readable immediately via " +
      "brain_read. Requires read+direct-write on that project base. For thematic bases use " +
      "brain_propose_edit (reviewed) instead.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string", description: "Project base handle or UUID." },
        base: { type: "string", description: "Alias for brain." },
        project: { type: "string", description: "Alias for brain." },
        note_id: { type: "string", description: "Stable note UUID to update (preserved)." },
        noteId: { type: "string", description: "Alias for note_id." },
        id: { type: "string", description: "Alias for note_id." },
        title: { type: "string", description: "Updated title (omit to keep current)." },
        body: { type: "string", description: "Updated Markdown (omit to keep current)." },
        folder_id: { type: "string", description: "Optional new folder UUID." },
        folder: { type: "string", description: "Alias for folder_id." },
      },
      required: ["brain", "note_id"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_create",
    description:
      "Create (or return) a private PROJECT base keyed by stable external project_id, not the " +
      "display title. Needs the token's separate create-project grant to create; repeats with " +
      "the same project_id return the existing base when this token is already scoped for it " +
      "(even after the create grant was removed) without creating anything new. Same " +
      "title/different IDs yield different projects. Thematic bases are created in the web " +
      "workspace, not here. Without write access, keep prepared Markdown in the user reply. " +
      "Goal/description is optional compatibility input (no exam prerequisite).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Display name, e.g. \"Design system\"." },
        goal: {
          type: "string",
          description: "Optional description (compatibility input, no exam prerequisite).",
        },
        description: { type: "string", description: "Alias for goal." },
        topic: {
          type: "string",
          description:
            "Catalogue field: web, backend, gamedev, mobile, ai, data, devops, " +
            "design, security, product, other.",
        },
        project_id: {
          type: "string",
          description: "Stable external project ID (required, not the display title).",
        },
        projectId: { type: "string", description: "Alias for project_id." },
        project: { type: "string", description: "Alias for project_id when creating." },
      },
      required: ["title", "project_id"],
      additionalProperties: false,
    },
  },
];
