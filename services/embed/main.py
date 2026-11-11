"""
Embedding service — bge-m3, 1024 dims, strong on Russian and English.

Local and free, which matters twice over: brains will be half-Russian, and it
removes one more paid dependency from the stack.

  POST /embed   {"texts": ["..."], "kind": "passage" | "query"}  -> {"vectors": [[...]], "dim": 1024, "model": ..., "fingerprint_id": ..., "confirmed": bool}
  POST /rerank  {"query": "...", "documents": [...], "top_n": N} -> {"results": [{index, score}]}
  GET  /health            (never waits for the inference lock; loaded:false while warming)
  GET  /fingerprint       (fields + id + confirmed, no model load required)
"""

from __future__ import annotations

import itertools
import math
import os
import queue as queue_mod
import threading
from concurrent.futures import Future
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from fingerprint import (
    FINGERPRINT_FIELDS,
    build_fingerprint,
    canonical_fingerprint_json,
    checkpoint_settings,
    fingerprint_id,
    resolve_revision,
)

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-m3")
MAX_BATCH = int(os.environ.get("EMBED_MAX_BATCH", "64"))
RERANK_MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
# Cap on documents per /rerank call — a cross-encoder scores every (query, doc)
# pair, so cost is linear in the list and the caller (search.ts) only needs the
# top of the RRF fusion rescored anyway.
RERANK_MAX_DOCS = int(os.environ.get("RERANK_MAX_DOCS", "64"))
# int8 dynamic quantization for the cross-encoder. Measured motivation: the
# fp32 reranker on CPU put production search at p50 6.9s / p95 54s — the
# single worst number in the product. Dynamic quantization of the Linear
# layers is 2-3x on CPU for this architecture, and the self-test below judges
# the QUANTIZED model, so a quantization that breaks ranking refuses itself.
RERANK_QUANTIZE = os.environ.get("RERANK_QUANTIZE", "") == "1"

# Torch defaults to half the host's cores, which is the wrong split when two of
# these run side by side: one lane serving interactive search, one chewing
# through ingest batches. Measured on the 16-core production host, reranking a
# full candidate set took 7.0s on torch's default 8 threads and 4.2s on 14 — so
# the number is worth setting deliberately rather than inheriting, and the two
# lanes together should not ask for more than the host has.
EMBED_THREADS = int(os.environ.get("EMBED_THREADS", "0"))
if EMBED_THREADS > 0:
    try:
        import torch

        torch.set_num_threads(EMBED_THREADS)
    except Exception:
        pass

# ─── fingerprint fields (no model load required) ────────────────────────────
# bge-m3 needs no asymmetric prefixes (unlike e5). The service reports the
# prefixes it really applies and applies them itself; Node sends raw text and
# never adds a prefix a second time.

EMBED_TOKENIZER = os.environ.get("EMBED_TOKENIZER", "bge-m3")
EMBED_POOLING = os.environ.get("EMBED_POOLING", "cls")
EMBED_NORMALIZE = os.environ.get("EMBED_NORMALIZE", "1") != "0"
EMBED_MAX_LENGTH = int(os.environ.get("EMBED_MAX_LENGTH", "8192"))
EMBED_QUERY_PREFIX = os.environ.get("EMBED_QUERY_PREFIX", "")
EMBED_PASSAGE_PREFIX = os.environ.get("EMBED_PASSAGE_PREFIX", "")
EMBED_DIM_EXPECTED = int(os.environ.get("EMBED_DIM", "1024"))


def _model_dir_or_none() -> str | None:
    # A local directory (Docker volume /models/bge-m3) vs a remote HF name.
    name = MODEL_NAME
    try:
        if os.path.isdir(name):
            return name
    except Exception:
        pass
    return None


def fingerprint_fields() -> dict:
    # Fallbacks apply only when the checkpoint does not say. encode() always
    # L2-normalises and applies the prefixes below, so those two follow the
    # code path rather than a label the encoder ignores.
    fields = {
        "model": MODEL_NAME,
        "revision": resolve_revision(_model_dir_or_none()),
        "tokenizer": EMBED_TOKENIZER,
        "pooling": EMBED_POOLING,
        "normalize": True,
        "max_length": EMBED_MAX_LENGTH,
        "query_prefix": EMBED_QUERY_PREFIX,
        "passage_prefix": EMBED_PASSAGE_PREFIX,
        "dim": EMBED_DIM_EXPECTED,
    }
    fields.update(checkpoint_settings(_model_dir_or_none()))
    fields["normalize"] = True
    fields["query_prefix"] = EMBED_QUERY_PREFIX
    fields["passage_prefix"] = EMBED_PASSAGE_PREFIX
    return fields


def fingerprint_record() -> dict:
    return build_fingerprint(fingerprint_fields())


def _device_info() -> dict:
    try:
        import torch

        if torch.cuda.is_available():
            try:
                name = torch.cuda.get_device_name(0)
            except Exception:
                name = "cuda"
            return {"device": "cuda", "device_name": name}
        return {"device": "cpu"}
    except Exception:
        return {"device": "cpu"}


app = FastAPI(title="mozg-embed")

# Lazy to keep /health responsive while weights load: None until first encode
# (or the background warm thread finishes). /health and /fingerprint never
# touch the inference lock.
_model = None  # SentenceTransformer | None
_reranker = None  # CrossEncoder | None

# ─── single inference thread with query priority ────────────────────────────
# One torch stream: queries jump ahead of the next waiting passage batch,
# including when query and passage hit the same endpoint. PriorityQueue orders
# by (priority, seq): query=0 beats passage=1, FIFO inside each lane.

_job_queue: queue_mod.PriorityQueue = queue_mod.PriorityQueue()
_job_seq = itertools.count()
_worker_started = False
_worker_lock = threading.Lock()


def _ensure_worker() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        t = threading.Thread(target=_inference_loop, name="embed-infer", daemon=True)
        t.start()
        _worker_started = True


def _inference_loop() -> None:
    while True:
        _priority, _seq, fut, texts, kind = _job_queue.get()
        try:
            vecs = _encode_now(texts, kind)
            if not fut.done():
                fut.set_result(vecs)
        except Exception as e:  # noqa: BLE001 — the waiter sees the failure
            if not fut.done():
                fut.set_exception(e)
        finally:
            _job_queue.task_done()


def _encode_now(texts: list[str], kind: str):
    m = model()
    # Service-side prefixes (empty for bge-m3): applied here, never by Node.
    if kind == "query" and EMBED_QUERY_PREFIX:
        texts = [EMBED_QUERY_PREFIX + t for t in texts]
    elif kind == "passage" and EMBED_PASSAGE_PREFIX:
        texts = [EMBED_PASSAGE_PREFIX + t for t in texts]
    vectors = m.encode(
        texts,
        normalize_embeddings=True,
        batch_size=min(len(texts), 16),
        show_progress_bar=False,
    )
    return vectors


def submit_inference(texts: list[str], kind: str, timeout: float | None) -> list:
    _ensure_worker()
    fut: Future = Future()
    seq = next(_job_seq)
    priority = 0 if kind == "query" else 1
    _job_queue.put((priority, seq, fut, list(texts), kind))
    return fut.result(timeout=timeout)


def model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(MODEL_NAME)
    return _model


# One obvious pair. A working cross-encoder scores the first far above the
# second; a model whose classifier head was newly initialised scores both at
# roughly 0.5 in whatever order it feels like.
_SELF_TEST = [
    ("what is the capital of France", "Paris is the capital of France."),
    ("what is the capital of France", "Bananas are yellow."),
]


def reranker():
    global _reranker
    if _reranker is None:
        from sentence_transformers import CrossEncoder

        # Lazy, unlike the embedding model: the reranker is optional and its
        # weights sit on top of bge-m3's, so we only pay for it once reranking
        # is actually requested. A missing model dir raises here and /rerank
        # answers 503 — /embed and /health are untouched.
        model = CrossEncoder(RERANK_MODEL, max_length=512)

        if RERANK_QUANTIZE:
            try:
                import torch

                model.model = torch.ao.quantization.quantize_dynamic(
                    model.model, {torch.nn.Linear}, dtype=torch.qint8
                )
                print("[rerank] dynamic int8 quantization applied")
            except Exception as e:  # noqa: BLE001 — fp32 is a fine fallback
                print(f"[rerank] quantization failed, serving fp32: {e}")

        # Refuse to serve a reranker that cannot tell relevant from unrelated.
        #
        # Transformers only *warns* when a checkpoint has no classifier head
        # and builds a random one, so the service would come up healthy and
        # reorder every search by noise — strictly worse than having no
        # reranker at all, and invisible unless someone reads the scores. This
        # has happened once: an embedding model's files in the reranker's
        # directory, every score ~0.5, the right answer ranked last.
        good, bad = model.predict(_SELF_TEST)
        if not good > bad + 0.05:
            if RERANK_QUANTIZE:
                # The quantized model failed the judgment test — fp32 is slower
                # but correct, and correct wins. Reload clean and re-judge.
                print(
                    f"[rerank] quantized model failed self-test "
                    f"(relevant={good:.4f} vs unrelated={bad:.4f}) — reloading fp32"
                )
                model = CrossEncoder(RERANK_MODEL, max_length=512)
                good, bad = model.predict(_SELF_TEST)
            if not good > bad + 0.05:
                raise RuntimeError(
                    f"reranker at {RERANK_MODEL} failed its self-test "
                    f"(relevant={good:.4f} vs unrelated={bad:.4f}) — the classifier "
                    "head is probably untrained. Refusing to serve it; search falls "
                    "back to RRF order."
                )

        _reranker = model
    return _reranker


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1)
    # bge-m3 needs no asymmetric prefixes, unlike e5. Kept in the contract so a
    # model swap does not become an API change.
    kind: Literal["passage", "query"] = "passage"


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    dim: int
    model: str
    fingerprint_id: str
    confirmed: bool


@app.get("/health")
def health() -> dict[str, object]:
    # Never waits for the inference lock and never loads the model: while
    # weights are still streaming the page stays usable (Markdown reads and
    # edits work; only semantic search is lexical).
    loaded = _model is not None
    try:
        fp = fingerprint_record()
    except Exception:
        fp = {"id": "", "confirmed": False}
    info = _device_info()
    dim: object = None
    if loaded:
        try:
            dim = int(_model.get_sentence_embedding_dimension())  # type: ignore[union-attr]
        except Exception:
            dim = EMBED_DIM_EXPECTED
    return {
        "ok": True,
        "model": MODEL_NAME,
        "loaded": loaded,
        "dim": dim,
        "reranker": RERANK_MODEL,
        "reranker_loaded": _reranker is not None,
        "threads": EMBED_THREADS or None,
        "device": info.get("device"),
        "device_name": info.get("device_name"),
        "max_batch": MAX_BATCH,
        "fingerprint_id": fp.get("id"),
        "confirmed": fp.get("confirmed"),
    }


@app.get("/fingerprint")
def fingerprint() -> dict[str, object]:
    rec = fingerprint_record()
    return {
        "fields": rec["fields"],
        "canonical": rec["canonical"],
        "id": rec["id"],
        "confirmed": rec["confirmed"],
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if len(req.texts) > MAX_BATCH:
        raise HTTPException(413, f"batch too large: {len(req.texts)} > {MAX_BATCH}")
    if any(not t.strip() for t in req.texts):
        raise HTTPException(400, "empty text in batch")

    # Query jumps ahead of the next passage batch inside the single inference
    # thread; /health never queues, so it never waits here.
    timeout = 30.0 if req.kind == "query" else 300.0
    try:
        vectors = submit_inference(req.texts, req.kind, timeout=timeout)
    except TimeoutError:
        raise HTTPException(503, "embed inference timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"embed inference failed: {e}")

    rec = fingerprint_record()
    dim = int(rec["fields"]["dim"])
    # Validate before returning anything: count, dimensionality and finiteness.
    # Otherwise 422 with no partial write (no vectors are stored by this
    # service; the caller must not store a prefix of a bad batch either).
    try:
        vec_list = [list(v.tolist() if hasattr(v, "tolist") else v) for v in vectors]
    except Exception:
        raise HTTPException(422, "embed returned undecodable vectors")
    if len(vec_list) != len(req.texts):
        raise HTTPException(
            422, f"embed count mismatch: got {len(vec_list)} vectors for {len(req.texts)} texts"
        )
    for v in vec_list:
        if len(v) != dim:
            raise HTTPException(422, f"embed dim mismatch: got {len(v)}, expected {dim}")
        for x in v:
            if not isinstance(x, (int, float)) or not math.isfinite(float(x)):
                raise HTTPException(422, "embed returned non-finite values")
    return EmbedResponse(
        vectors=[[float(x) for x in v] for v in vec_list],
        dim=dim,
        model=MODEL_NAME,
        fingerprint_id=str(rec["id"]),
        confirmed=bool(rec["confirmed"]),
    )


class RerankRequest(BaseModel):
    query: str = Field(min_length=1)
    documents: list[str] = Field(min_length=1, max_length=RERANK_MAX_DOCS)
    top_n: int | None = None


class RerankResult(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    results: list[RerankResult]
    model: str


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    try:
        r = reranker()
    except Exception as e:
        # Weights not fetched (or OOM on load). The caller treats 503 as "no
        # reranker" and falls back to the plain RRF ranking.
        raise HTTPException(503, f"reranker unavailable: {e}")

    scores = r.predict(
        [[req.query, d] for d in req.documents],
        show_progress_bar=False,
    )
    order = sorted(range(len(req.documents)), key=lambda i: -float(scores[i]))
    if req.top_n is not None:
        order = order[: max(0, req.top_n)]
    return RerankResponse(
        results=[RerankResult(index=i, score=float(scores[i])) for i in order],
        model=RERANK_MODEL,
    )


@app.on_event("startup")
def warm() -> None:
    # Warm in the background so /health answers (loaded:false) while weights
    # stream. The first /embed pays nothing extra once this lands; until then
    # it loads on demand through the same single inference thread.
    def _bg() -> None:
        try:
            model()
        except Exception as exc:  # noqa: BLE001 — degraded service beats no service
            print(f"[embed] background warm failed: {exc}")
        # The reranker must load here too, and not only for latency: lazy loading
        # happens inside FastAPI's worker thread, where torch initialises modules
        # on the meta device and then dies with "Cannot copy out of meta tensor"
        # — the same weights load fine from the main thread. Failure stays
        # non-fatal: /rerank keeps answering 503 and search falls back to RRF.
        try:
            reranker()
        except Exception as exc:  # noqa: BLE001 — degraded service beats no service
            print(f"[embed] reranker unavailable at boot: {exc}")

    try:
        _ensure_worker()
    except Exception:
        pass
    threading.Thread(target=_bg, name="embed-warm", daemon=True).start()
