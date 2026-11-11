/**
 * The MCP tool surface, as data.
 *
 * SVOD stage 2 (private fork): only tools that enforce per-user brain
 * permissions are exposed. Collective catalogue tools (brain_find,
 * library_add/remove), project memory (gen_*), workflows, handoffs, feedback,
 * refresh and source ingestion are removed from the list and the dispatcher —
 * proposals stay pending and per-token scopes arrive in stage 4.
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
      "List the knowledge brains available to you. Call this once at the start " +
      "of a session, or whenever the user names a brain (e.g. \"use mozg:design\"). " +
      "Returns each brain's handle, what it is for, and how well it is trained.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "brain_brief",
    description:
      "Get a compact map of one brain: its goal, the categories of knowledge it " +
      "holds, its known gaps, and any unfinished work an earlier session left " +
      "here. Cheap — call it before searching so you know whether this brain " +
      "can answer the question at all and which words it uses. Do not skip this " +
      "and guess at search terms.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string", description: "Brain handle, e.g. \"design\"." },
      },
      required: ["brain"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_search",
    description:
      "Search a brain for knowledge relevant to your current task. Call this " +
      "BEFORE answering, whenever the question names a file, a version, an API, " +
      "a config key or a convention — or asks how something is done \"here\", " +
      "\"in this project\" or \"in our setup\". Those are the answers your " +
      "training data has an outdated version of and will give confidently. " +
      "Skip it for general programming questions this brain has no stake in. " +
      "Prefer several short, specific queries over one long one. Returns ranked " +
      "excerpts with note ids — excerpts are cut short; brain_read gives the " +
      "full note.",
    inputSchema: {
      type: "object",
      properties: {
        brain: {
          type: "string",
          description:
            "Brain handle. Optional: without it, your whole shelf is searched " +
            "and the answer names the brain each passage came from.",
        },
        query: { type: "string", description: "What you need to know." },
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
      "Read the full text of one note returned by brain_search, when the excerpt " +
      "is not enough to act on.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string" },
        note_id: { type: "string", description: "id from a brain_search result." },
      },
      required: ["brain", "note_id"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_write",
    description:
      "Save a durable lesson back into the brain: a convention you confirmed, a " +
      "correction to something the brain had wrong, a pitfall you hit. The " +
      "moment to call it is when you have just worked something out that took " +
      "real digging and would take the next session the same digging. Write one " +
      "self-contained fact per call — it will be read alone, months later, by " +
      "someone with none of this conversation, so name the file, version or " +
      "number it turns on and say why, not only what. Do not save what the " +
      "repository or this chat already records, and never save credentials, " +
      "tokens or personal data. Notes are always saved as proposals for review " +
      "and answer nobody until approved, so write it anyway rather " +
      "than dropping what you learned.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string" },
        title: {
          type: "string",
          description:
            "Short and searchable. Optional — sending only `body` titles the " +
            "note by its first sentence rather than refusing it.",
        },
        body: { type: "string", description: "The fact, in full sentences." },
        kind: {
          type: "string",
          enum: ["fact", "rule", "layout", "example", "pitfall"],
        },
        category: { type: "string", description: "Reuse an existing category." },
      },
      required: ["brain", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_write_batch",
    description:
      "Save several lessons at once — the same rules as brain_write, up to 25 " +
      "notes per call. Prefer this when a training session produced a set of " +
      "notes: one call instead of many. Each note is scanned, deduplicated and " +
      "saved on its own, so one rejection loses nothing else — read the " +
      "per-note results in the reply and only redo the ones that failed. Notes " +
      "are always saved as proposals for review.",
    inputSchema: {
      type: "object",
      properties: {
        brain: { type: "string" },
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
    name: "brain_create",
    description:
      "Create a new private base. The goal becomes an exam the brain is " +
      "scored against, so write it as an outcome rather than a subject. " +
      "Creating the same title twice returns the existing brain instead of a " +
      "duplicate. New bases are private: access is granted per base by the operator.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short name, e.g. \"Design system\"." },
        goal: {
          type: "string",
          description: "What it must be able to answer. Concrete; this becomes the exam.",
        },
        topic: {
          type: "string",
          description:
            "Catalogue field: web, backend, gamedev, mobile, ai, data, devops, " +
            "design, security, product, other.",
        },
        parent: {
          type: "string",
          description:
            "Handle of a brain to group this one under, for a large subject " +
            "split into parts. Searching the parent then searches every child. One level " +
            "only — a child cannot have children.",
        },
      },
      required: ["title", "goal"],
      additionalProperties: false,
    },
  },
];
