import { env } from "@/lib/env";

/** Client for services/embed (bge-m3, 1024 dims, normalised). */

const MAX_BATCH = 64;
/** Stage 5 worker passage batch: small, so an edited note never waits
 *  behind a corpus tail. The service contract still allows up to 64 for old
 *  callers; the Svod worker never sends more than 8. */
export const SVOD_PASSAGE_BATCH = 8;

async function post(texts: string[], kind: "passage" | "query"): Promise<number[][]> {
  // A query goes to the interactive lane and gives up quickly; a passage batch
  // goes to the ingest lane and may wait, because nobody is watching it. Same
  // service, deliberately different queues — see docker-compose.prod.yml.
  const interactive = kind === "query";
  const base = interactive ? env.EMBED_QUERY_URL : env.EMBED_URL;

  const res = await fetch(`${base}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts, kind }),
    signal: AbortSignal.timeout(interactive ? 10_000 : 120_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embed service ${res.status}: ${detail.slice(0, 300)}`);
  }

  // Stage 5 service also returns fingerprint_id/confirmed; old callers ignore
  // the extra fields (same batch contract, up to 64).
  const json = (await res.json()) as {
    vectors: number[][];
    dim: number;
    fingerprint_id?: unknown;
    confirmed?: unknown;
  };

  if (json.dim !== env.EMBED_DIM) {
    // The chunks.embedding column is vector(1024). A model swap that changes
    // dimensions needs a migration + re-embed, so fail loudly rather than
    // writing vectors Postgres will reject one row at a time.
    throw new Error(
      `embed dim mismatch: service returned ${json.dim}, schema expects ${env.EMBED_DIM}`,
    );
  }

  return json.vectors;
}

/** Embed text that will be stored and searched over. */
export async function embedPassages(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    out.push(...(await post(texts.slice(i, i + MAX_BATCH), "passage")));
  }
  return out;
}

/** Embed a search query. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await post([text], "query");
  return vector;
}

export async function embedHealthy(): Promise<boolean> {
  // Generous on purpose: the embedder is a single torch process, and a big
  // re-read wave queues enough batches that /health itself waits in line.
  // Saturated-but-alive must read as healthy — flapping the site to 503
  // because ingest is busy pages the operator for a non-event. 15s of
  // silence, tried twice, is what "actually down" looks like.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${env.EMBED_URL}/health`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
    } catch {
      // fall through to the second attempt
    }
  }
  return false;
}

// ─── Stage 5: fingerprints + query-only cache ─────────────────────────────

export interface EmbedFingerprint {
  id: string;
  confirmed: boolean;
}

async function fetchFingerprint(base: string): Promise<EmbedFingerprint> {
  const res = await fetch(`${base}/fingerprint`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`fingerprint ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id?: unknown; confirmed?: unknown };
  if (typeof json.id !== "string" || !json.id) throw new Error("fingerprint missing id");
  return { id: json.id, confirmed: json.confirmed === true };
}

export interface SvodEmbedState {
  usable: boolean;
  fingerprintId: string | null;
  reason: string | null;
  passage: EmbedFingerprint | null;
  query: EmbedFingerprint | null;
}

/**
 * Compare EMBED_URL and EMBED_QUERY_URL fingerprints. Semantic search and
 * vector writes are allowed only when both answers are confirmed and the ids
 * match. Anything else is lexical-only, with the reason for the status line.
 * Never throws: a dead service is `usable:false`, not an exception.
 */
export async function getSvodEmbedState(): Promise<SvodEmbedState> {
  let passage: EmbedFingerprint | null = null;
  let qfp: EmbedFingerprint | null = null;
  try {
    const [p, q] = await Promise.all([
      fetchFingerprint(env.EMBED_URL),
      fetchFingerprint(env.EMBED_QUERY_URL),
    ]);
    passage = p;
    qfp = q;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      usable: false,
      fingerprintId: null,
      reason: `embed service unavailable (${msg.slice(0, 120)})`,
      passage,
      query: qfp,
    };
  }
  if (!passage.confirmed || !qfp.confirmed) {
    return {
      usable: false,
      fingerprintId: null,
      reason: "embed fingerprint unconfirmed (model revision unknown)",
      passage,
      query: qfp,
    };
  }
  if (passage.id !== qfp.id) {
    return {
      usable: false,
      fingerprintId: null,
      reason: "query/passage fingerprint mismatch",
      passage,
      query: qfp,
    };
  }
  return { usable: true, fingerprintId: passage.id, reason: null, passage, query: qfp };
}

function validateSvodVectors(vectors: unknown, expected: number): asserts vectors is number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error(`embed count mismatch: got ${Array.isArray(vectors) ? vectors.length : "?"} for ${expected}`);
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== env.EMBED_DIM) {
      throw new Error(`embed dim mismatch: got ${Array.isArray(v) ? v.length : "?"} , expected ${env.EMBED_DIM}`);
    }
    for (const x of v) {
      if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("embed returned non-finite values");
    }
  }
}

// Query-only LRU (128) keyed by confirmed fingerprint id + exact text.
// Parallel identical misses share one in-flight Promise. Passage is never
// cached. A different fingerprint is a different key (miss). Unconfirmed
// fingerprints are never cached and never used for semantic search.
const QUERY_CACHE_MAX = 128;
const queryCache = new Map<string, number[]>();
const queryInflight = new Map<string, Promise<number[]>>();

function queryCacheKey(fingerprintId: string, text: string): string {
  return `${fingerprintId}\n${text}`;
}

function queryCacheGet(key: string): number[] | undefined {
  const v = queryCache.get(key);
  if (v === undefined) return undefined;
  // Refresh LRU order.
  queryCache.delete(key);
  queryCache.set(key, v);
  return v;
}

function queryCacheSet(key: string, vec: number[]): void {
  if (queryCache.has(key)) queryCache.delete(key);
  queryCache.set(key, vec);
  while (queryCache.size > QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
}

/** Test-only: empty the query cache and in-flight map. */
export function clearSvodQueryCache(): void {
  queryCache.clear();
  queryInflight.clear();
}

/** Test-only: current cache size. */
export function svodQueryCacheSize(): number {
  return queryCache.size;
}

async function postSvod(
  base: string,
  texts: string[],
  kind: "passage" | "query",
): Promise<{ vectors: number[][]; fingerprintId: string }> {
  const res = await fetch(`${base}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts, kind }),
    signal: AbortSignal.timeout(kind === "query" ? 10_000 : 120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embed service ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    vectors: unknown;
    dim: unknown;
    fingerprint_id?: unknown;
  };
  if (json.dim !== env.EMBED_DIM) {
    throw new Error(`embed dim mismatch: service returned ${String(json.dim)}, schema expects ${env.EMBED_DIM}`);
  }
  validateSvodVectors(json.vectors, texts.length);
  const fpId = typeof json.fingerprint_id === "string" ? json.fingerprint_id : "";
  return { vectors: json.vectors, fingerprintId: fpId };
}

/**
 * Embed one search query for the Svod path. Uses the confirmed fingerprint
 * id + exact text as the cache key. Throws when semantic search is not
 * usable (dead service, unconfirmed or mismatched fingerprints) — the caller
 * falls back to lexical without surfacing an error.
 */
export async function embedSvodQuery(text: string): Promise<number[]> {
  const state = await getSvodEmbedState();
  if (!state.usable || !state.fingerprintId) throw new Error(state.reason ?? "semantic search unavailable");
  const key = queryCacheKey(state.fingerprintId, text);
  const hit = queryCacheGet(key);
  if (hit) return hit;
  const flying = queryInflight.get(key);
  if (flying) return flying;
  const p = (async () => {
    try {
      const { vectors, fingerprintId } = await postSvod(env.EMBED_QUERY_URL, [text], "query");
      // The fingerprint must still be the one we keyed on; otherwise this
      // response belongs to a rotated model and must not poison the cache.
      if (fingerprintId && fingerprintId !== state.fingerprintId) {
        throw new Error("fingerprint rotated during query");
      }
      const vec = vectors[0];
      queryCacheSet(key, vec);
      return vec;
    } finally {
      queryInflight.delete(key);
    }
  })();
  queryInflight.set(key, p);
  return p;
}

/**
 * Embed passage texts for the Svod worker. No cache. The caller must have
 * checked getSvodEmbedState() usable; this re-checks and refuses to return
 * vectors when the fingerprints do not allow a write. Vectors come only from
 * the passage endpoint. Node sends raw text (service applies its prefixes).
 */
export async function embedSvodPassages(texts: string[]): Promise<{ vectors: number[][]; fingerprintId: string }> {
  if (!texts.length) return { vectors: [], fingerprintId: "" };
  if (texts.length > SVOD_PASSAGE_BATCH) {
    throw new Error(`svod passage batch too large: ${texts.length} > ${SVOD_PASSAGE_BATCH}`);
  }
  const state = await getSvodEmbedState();
  if (!state.usable || !state.fingerprintId) throw new Error(state.reason ?? "semantic search unavailable");
  const { vectors, fingerprintId } = await postSvod(env.EMBED_URL, texts, "passage");
  if (fingerprintId && fingerprintId !== state.fingerprintId) {
    throw new Error("fingerprint rotated during passage batch");
  }
  return { vectors, fingerprintId: state.fingerprintId };
}
