import { query, toVector } from "@/db";
import { parseTools, type BrainTool } from "@/lib/brain-tools";
import { embedQuery } from "@/lib/embed";
import { applyRerank, keepRelevant, rerank } from "@/lib/rerank";
import { toTsQuery } from "@/lib/tsquery";
import { normalizeCategory, topLevelCategory } from "@/lib/category";

/**
 * Hybrid retrieval: vector + full-text, fused with Reciprocal Rank Fusion,
 * then rescored by a cross-encoder when one is available.
 *
 * RRF combines the two rankings without needing their scores to be on the same
 * scale — cosine distance and ts_rank never are, and calibrating them against
 * each other is a tuning job that never ends. Ranks are comparable by
 * construction, so there is nothing to tune.
 *
 * The reranker (bge-reranker-v2-m3) then reads the query together with each of
 * the top candidates and reorders them — a cross-encoder ranks pairs far
 * better than the bi-encoder behind the vector leg, but at per-pair cost, so
 * it only ever sees RERANK_CANDIDATES. It is optional: weights not fetched or
 * service down means the RRF order is returned as-is.
 */

/** RRF damping. 60 is the value from the original paper and behaves well. */
const K = 60;
const CANDIDATES = 30;
/**
 * How many RRF winners the reranker rescores; also the SQL fetch size.
 *
 * 12 rather than 25, measured on the production box at the sizes real chunks
 * have: 25 candidates cost 14.0s, 16 cost 4.1s, 12 cost 2.0s. Recall past rank
 * 12 is not what wins searches — RRF has already agreed twice by then — and this
 * is the difference between an agent waiting seven seconds and two.
 */
const RERANK_CANDIDATES = 12;

export interface SearchHit {
  note_id: string;
  chunk_id: string;
  title: string;
  category: string | null;
  kind: string;
  excerpt: string;
  score: number;
  /**
   * The cross-encoder's verdict on this passage against this query, when the
   * reranker ran. Unlike `score` it is absolute — 0..1, where a genuinely
   * relevant passage lands near 1 and an off-topic one near 0, whatever else
   * came back in the same result set.
   */
  rerank?: number;
  /** Which retriever(s) surfaced it — useful when debugging a bad answer. */
  via: "vector" | "text" | "both";
  /** Which brain it came from. Only interesting when searching a family. */
  brain_slug: string;
  brain_title: string;
}

export interface SearchOptions {
  limit?: number;
  category?: string | null;
  /**
   * Wait for the reranker instead of giving up at the interactive deadline.
   *
   * For a background caller the 8s budget is the wrong ceiling: the reranker
   * is one torch process shared with every other pass the worker runs, and a
   * call that gives up at 8s makes the exam throw the whole sitting away with
   * "graded without the reranker" — twice on the night of 2026-08-11. Nobody
   * is watching an exam, and waiting costs less than re-running it.
   *
   * The caller owns the ceiling on how long it stays patient overall; see
   * RETRIEVAL_BUDGET_MS in worker/exam.ts.
   */
  patient?: boolean;
}

/** The background deadline. See SearchOptions.patient. */
const PATIENT_RERANK_MS = 60_000;

/**
 * `brainIds` takes a family: searching a parent reaches its children, so an
 * agent that knows the product name does not need to know how the owner split
 * it up. A single id behaves exactly as before.
 */
export async function searchBrain(
  brainIds: string | string[],
  q: string,
  opts: SearchOptions = {},
): Promise<{
  hits: SearchHit[];
  degraded: boolean;
  reranked: boolean;
  /**
   * The best score the relevance floor threw away, when it threw away
   * everything. Null whenever something survived. This is the only way to
   * tell "the brain holds nothing on this" from "the brain held something and
   * we judged it off-topic" — and the second one, if it starts happening to
   * real questions, is the regression the floor could cause.
   */
  withheld?: number | null;
}> {
  const ids = Array.isArray(brainIds) ? brainIds : [brainIds];
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
  // Normalised the same way the write paths store it, so an agent asking for
  // "Type scale" finds notes extraction filed as "type scale".
  const category = normalizeCategory(opts.category);
  const text = q.trim();
  if (!text) return { hits: [], degraded: false, reranked: false };

  // A dead embedding service degrades search to full-text instead of failing
  // the agent's tool call. Half an answer beats an error mid-task.
  let vector: string | null = null;
  let degraded = false;
  try {
    vector = toVector(await embedQuery(text));
  } catch {
    degraded = true;
  }

  const rows = await query<{
    chunk_id: string;
    note_id: string;
    title: string;
    category: string | null;
    kind: string;
    excerpt: string;
    score: string;
    in_vec: boolean;
    in_fts: boolean;
    brain_slug: string;
    brain_title: string;
  }>(
    `
    with params as (
      select $2::halfvec as v,
             case when $3::text is null then null
                  else to_tsquery('simple', $3) end as tsq,
             $4::text as cat
    ),
    vec as (
      select c.id, c.note_id,
             row_number() over (order by c.embedding <=> (select v from params)) as rank
        from chunks c
        join notes n on n.id = c.note_id
       where c.brain_id = any($1::uuid[])
         and n.status = 'active'
         and c.embedding is not null
         and (select v from params) is not null
         and ((select cat from params) is null
              or lower(n.category) = (select cat from params)
              -- A top-level filter reaches its subcategories: "typography"
              -- also matches "typography/scale". lower() covers rows written
              -- before category normalisation existed.
              or lower(n.category) like (select cat from params) || '/%')
       order by c.embedding <=> (select v from params)
       limit ${CANDIDATES}
    ),
    fts as (
      select c.id, c.note_id,
             row_number() over (
               order by ts_rank_cd(c.tsv, (select tsq from params)) desc
             ) as rank
        from chunks c
        join notes n on n.id = c.note_id
       where c.brain_id = any($1::uuid[])
         and n.status = 'active'
         and (select tsq from params) is not null
         and c.tsv @@ (select tsq from params)
         and ((select cat from params) is null
              or lower(n.category) = (select cat from params)
              -- A top-level filter reaches its subcategories: "typography"
              -- also matches "typography/scale". lower() covers rows written
              -- before category normalisation existed.
              or lower(n.category) like (select cat from params) || '/%')
       order by ts_rank_cd(c.tsv, (select tsq from params)) desc
       limit ${CANDIDATES}
    ),
    fused as (
      select id, note_id,
             sum(1.0 / (${K} + rank)) as score,
             bool_or(src = 'v') as in_vec,
             bool_or(src = 'f') as in_fts
        from (
          select id, note_id, rank, 'v' as src from vec
          union all
          select id, note_id, rank, 'f' as src from fts
        ) u
       group by id, note_id
    )
    -- The usage weight enters as a bounded multiplier on the fused RRF
    -- score, not as its own leg: feedback nudges a ranking built from the
    -- query, it never outvotes the query. notes.weight is clamped to
    -- 0.5-2.0 by the schema, so a flagged note sinks but keeps answering
    -- and a well-liked one rises but cannot crowd out a better match.
    -- The reranker after this reorders on query+text alone — the stronger,
    -- query-specific signal — and stays unweighted on purpose.
    select f.id as chunk_id, f.note_id, n.title, n.category, n.kind,
           c.content as excerpt, (f.score * n.weight)::text as score, f.in_vec, f.in_fts,
           b.slug as brain_slug, b.title as brain_title
      from fused f
      join chunks c on c.id = f.id
      join notes n on n.id = f.note_id
      join brains b on b.id = n.brain_id
     order by f.score * n.weight desc
     limit $5
    `,
    // Fetch enough for the rerank pass, not just the final page — the reranker
    // can promote a candidate that RRF put at #20 into the top-N.
    [ids, vector, toTsQuery(text), category, Math.max(limit, RERANK_CANDIDATES)],
  );

  const hits: SearchHit[] = rows.map((r) => ({
    note_id: r.note_id,
    chunk_id: r.chunk_id,
    title: r.title,
    category: r.category,
    kind: r.kind,
    excerpt: r.excerpt,
    score: Number(r.score),
    via: r.in_vec && r.in_fts ? "both" : r.in_vec ? "vector" : "text",
    brain_slug: r.brain_slug,
    brain_title: r.brain_title,
  }));

  // One candidate is already the answer; a dead reranker leaves the RRF order
  // untouched, which the caller reports as "no-rerank" degradation.
  if (hits.length <= 1) return { hits, degraded, reranked: false };

  // Title first: an atomic note's title is the strongest topical signal in it,
  // and the cross-encoder only reads the head of what it is given.
  const scores = await rerank(
    text,
    hits.map((h) => `${h.title}\n${h.excerpt}`),
    opts.patient ? { timeoutMs: PATIENT_RERANK_MS } : {},
  );
  if (!scores) return { hits: hits.slice(0, limit), degraded, reranked: false };

  // The cross-encoder's floor is enforced here, once, for everyone who
  // searches: MCP, the exam, chat.
  //
  // Hybrid retrieval nearly always returns SOMETHING — a true zero almost
  // never happens — so a brain asked a question outside its scope used to hand
  // back its five least-unrelated passages, and whoever read them answered
  // from adjacent material with full confidence. Measured across the
  // catalogue: ordinary checks pass at 82%, the probes that ask a brain to
  // admit a subject is not covered pass at 64%. That gap is this behaviour.
  //
  // A brain with nothing to say has to say nothing. The callers already handle
  // it: brain_search answers "no matches" and points at a brain that does hold
  // the subject, and the exam counts an unanswered out-of-scope probe as the
  // pass it is.
  const ranked = applyRerank(hits, scores, limit);
  const kept = keepRelevant(ranked);
  return {
    hits: kept,
    degraded,
    reranked: true,
    withheld: kept.length === 0 && ranked.length > 0 ? ranked[0].rerank : null,
  };
}

/**
 * Compact map of a brain, for the agent to read before searching: what it
 * covers, in what words, and — just as usefully — what it is known to be
 * missing.
 */
export interface BriefSubcategory {
  /** The full category string, e.g. "typography/scale" — pass it to brain_search's category filter as-is. */
  name: string;
  notes: number;
}

export interface BriefCategory {
  /** Top-level segment: "typography" for "typography/scale", or the whole category when it has no "/". */
  name: string;
  /** Notes across the whole group, subcategories included. */
  notes: number;
  children: BriefSubcategory[];
  /** Children beyond the per-group cap — the group is bigger than shown. */
  hiddenChildren: number;
}

export interface BrainBrief {
  goal: string | null;
  noteCount: number;
  /** Auto-synthesised per-category paragraphs (0041) — the brief leads with
   *  these; the category tree below them is the drill-down. Empty until the
   *  lazy compile has run at least once. */
  summaries: { category: string; body: string }[];
  categories: BriefCategory[];
  /** Top-level groups beyond the cap. Nonzero means this is a summary, not the full map. */
  hiddenCategories: number;
  sampleTitles: string[];
  knownGaps: string[];
  /**
   * What the brain has already read, newest first. An agent teaching a brain
   * from local material had no way to know this, so a training session re-read
   * and re-distilled pages the brain already held — the server deduplicated the
   * notes, which protected the storage and not the tokens the agent spent
   * getting there. This list is what makes "skip what is covered" possible.
   */
  covers: { label: string; notes: number }[];
  /** Sources beyond the cap: the list is a sample, not the inventory. */
  hiddenCovers: number;
  /**
   * Work left mid-flight on this brain, still unclaimed.
   *
   * A brief was a map of knowledge and nothing else, so an agent could read
   * everything the brain knows and still not learn that yesterday's session
   * stopped halfway through a migration. The batons were visible only through
   * brain_list, which an agent calls once at the start and never again — by
   * the time it picks a brain, the baton has scrolled out of its attention.
   * One call now answers both "what does this know" and "where was I".
   */
  batons: { title: string; agent: string | null; at: string }[];
  /**
   * Agent-written notes of the last week, by what happened to them.
   *
   * The number that goes up on its own is "notes written", and a brain tuned
   * to it fills with true, unactionable prose — which is worse than an empty
   * brain, because an empty brain does not answer confidently. Putting
   * accepted next to rejected on the same line is the cheapest defence: it
   * makes volume unreadable without its quality, so neither can be quoted
   * alone.
   */
  intake: { accepted: number; rejected: number; pending: number };
  /**
   * The local tools this brain's knowledge is executed with.
   *
   * A brain that teaches how to author a Spine skeleton by hand is teaching the
   * right thing to somebody without the Spine CLI and the wrong thing to
   * somebody with it — and the agent could not tell which it was, because
   * nothing here ever mentioned that a tool existed. See lib/brain-tools.ts.
   */
  tools: BrainTool[];
}

/**
 * Caps keep the brief a map rather than a dump: past a few dozen categories a
 * flat list costs more tokens than the orientation it buys. 200 raw rows is a
 * ceiling on the pathology, not a target — with normalised categories a brain
 * that still grows 200 distinct labels has a vocabulary problem, not a brief
 * problem.
 */
const MAX_CATEGORY_ROWS = 200;
/** Sources named in a brief. Enough to recognise the corpus, not to inventory it. */
const MAX_COVERS = 40;
const MAX_CATEGORY_GROUPS = 12;
const MAX_CHILDREN_PER_GROUP = 5;

function groupCategories(rows: { name: string; notes: number }[]): {
  groups: BriefCategory[];
  hidden: number;
} {
  const byTop = new Map<string, { notes: number; children: BriefSubcategory[] }>();
  for (const r of rows) {
    const top = topLevelCategory(r.name);
    let group = byTop.get(top);
    if (!group) {
      group = { notes: 0, children: [] };
      byTop.set(top, group);
    }
    group.notes += r.notes;
    // A category that *is* the top level has no child entry of its own.
    if (r.name !== top) group.children.push({ name: r.name, notes: r.notes });
  }

  const sorted = [...byTop.entries()]
    .map(([name, g]) => ({
      name,
      notes: g.notes,
      children: g.children.sort((a, b) => b.notes - a.notes),
    }))
    .sort((a, b) => b.notes - a.notes);

  const groups = sorted.slice(0, MAX_CATEGORY_GROUPS).map((g) => ({
    ...g,
    hiddenChildren: Math.max(0, g.children.length - MAX_CHILDREN_PER_GROUP),
    children: g.children.slice(0, MAX_CHILDREN_PER_GROUP),
  }));
  return { groups, hidden: sorted.length - groups.length };
}

export async function briefBrain(brainId: string): Promise<BrainBrief> {
  const [goalRow, summaries, categories, titles, gaps, covers, batons, intake] = await Promise.all([
    query<{ goal: string | null; note_count: number; tools: unknown }>(
      `select goal, note_count, tools from brains where id = $1`,
      [brainId],
    ),
    // The synthesised map of each category — largest first, capped like the
    // category tree so the brief stays a map rather than a dump.
    query<{ category: string; body: string }>(
      `select category, body from summaries
        where brain_id = $1 order by note_count desc limit 8`,
      [brainId],
    ),
    // Read wide and fold into a tree in code: a "/" in the category makes one
    // branch, and the SQL stays a plain GROUP BY instead of recursive CTE
    // gymnastics for a two-level display.
    query<{ name: string; notes: number }>(
      `select coalesce(lower(category), 'uncategorised') as name, count(*)::int as notes
         from notes where brain_id = $1 and status = 'active'
        group by 1 order by 2 desc limit ${MAX_CATEGORY_ROWS}`,
      [brainId],
    ),
    query<{ title: string }>(
      `select title from notes where brain_id = $1 and status = 'active'
        order by created_at desc limit 12`,
      [brainId],
    ),
    // Categories the latest exam could not answer — the agent should know not
    // to trust the brain here, and say so rather than guess. Negative checks
    // are excluded: failing those means the brain bluffs, not that material
    // is missing, and a bluff is not a gap to fill.
    query<{ category: string }>(
      `with latest as (
         select id from check_runs
          where brain_id = $1 and status = 'done'
          order by started_at desc limit 1
       )
       select c.category
         from checks c
         join check_results r on r.check_id = c.id
        where c.brain_id = $1 and r.run_id = (select id from latest)
          and c.kind = 'positive'
        group by c.category
       having count(*) filter (where r.passed) = 0`,
      [brainId],
    ),
    // Material already read, with how much it yielded. A URL is shown by its
    // path rather than in full: the agent needs to recognise the page, not to
    // fetch it, and forty full raw.githubusercontent URLs would cost more than
    // the orientation they buy.
    query<{ label: string; notes: number }>(
      `select coalesce(
                nullif(regexp_replace(url, '^https?://[^/]+/', ''), ''),
                original_name,
                kind
              ) as label,
              note_count as notes
         from sources
        where brain_id = $1 and status = 'ready' and note_count > 0
        order by processed_at desc nulls last
        limit ${MAX_COVERS + 1}`,
      [brainId],
    ),
    // Open, unexpired, whoever left them: a baton is for the next session, and
    // "next" is deliberately not "yours" — a different agent on a different
    // machine taking it up is the point of the table existing.
    query<{ title: string; agent: string | null; at: string }>(
      `select title, agent_client as agent,
              to_char(created_at at time zone 'UTC', 'MM-DD HH24:MI') as at
         from handoffs
        where brain_id = $1 and status = 'open' and expires_at > now()
        order by created_at desc limit 5`,
      [brainId],
    ),
    // Only agent-written notes: ingest's output is not something a reviewer
    // accepts or refuses, so counting it here would dilute the one ratio this
    // line exists to show.
    query<{ accepted: number; rejected: number; pending: number }>(
      `select count(*) filter (where status = 'active')::int as accepted,
              count(*) filter (where status = 'rejected')::int as rejected,
              count(*) filter (where status = 'pending')::int as pending
         from notes
        where brain_id = $1 and author = 'agent'
          and created_at > now() - interval '7 days'`,
      [brainId],
    ),
  ]);

  const { groups, hidden } = groupCategories(categories);

  return {
    goal: goalRow[0]?.goal ?? null,
    noteCount: goalRow[0]?.note_count ?? 0,
    tools: parseTools(goalRow[0]?.tools),
    summaries,
    categories: groups,
    hiddenCategories: hidden,
    covers: covers.slice(0, MAX_COVERS),
    hiddenCovers: Math.max(0, covers.length - MAX_COVERS),
    sampleTitles: titles.map((t) => t.title),
    knownGaps: gaps.map((g) => g.category),
    batons,
    intake: intake[0] ?? { accepted: 0, rejected: 0, pending: 0 },
  };
}


