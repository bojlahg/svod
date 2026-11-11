"""
Stage 5 fingerprint — pure functions, no torch/weights.

The fingerprint identifies the exact checkpoint + encoding settings that
produced a vector. Vectors are reusable only when the fingerprint id matches
on both endpoints and is confirmed (non-empty revision).

Fields in the hash, in stable order:
  model, revision, tokenizer, pooling, normalize, max_length,
  query_prefix, passage_prefix, dim.

Thread count, CPU/GPU and batch size are NOT in the hash (they do not change
the numbers); they may be shown in /health.
"""

from __future__ import annotations

import hashlib
import json
import os

FINGERPRINT_FIELDS = [
    "model",
    "revision",
    "tokenizer",
    "pooling",
    "normalize",
    "max_length",
    "query_prefix",
    "passage_prefix",
    "dim",
]

# Files consulted for the revision when EMBED_REVISION is unset, in order.
REVISION_FILES = (
    "revision.txt",
    ".revision",
    "REVISION",
    "commit.txt",
    "GIT_REVISION",
    "revision",
)


def canonical_fingerprint_json(fields: dict) -> str:
    """Canonical JSON of the fingerprint fields.

    Keys are emitted in FINGERPRINT_FIELDS order regardless of the input
    dict order, with compact separators and UTF-8 preserved — so two
    processes holding the same settings always hash the same bytes.
    Only the nine fingerprint fields enter the hash; anything else is ignored.
    """
    ordered = {k: fields[k] for k in FINGERPRINT_FIELDS if k in fields}
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False)


def fingerprint_id(canonical_json: str) -> str:
    """Fingerprint id: SHA-256 hex of the canonical JSON bytes (UTF-8)."""
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def build_fingerprint(fields: dict) -> dict:
    """Full fingerprint record: fields + id + confirmed.

    Confirmed requires a non-empty revision — without it the vector's
    provenance is unknown and semantic search must stay lexical.
    """
    canonical = canonical_fingerprint_json(fields)
    revision = str(fields.get("revision", "") or "").strip()
    return {
        "fields": {k: fields[k] for k in FINGERPRINT_FIELDS if k in fields},
        "canonical": canonical,
        "id": fingerprint_id(canonical),
        "confirmed": bool(revision),
    }


def checkpoint_settings(model_dir: str | None) -> dict:
    """Pooling, length, tokenizer and dimension read from the checkpoint.

    `encode()` uses the files in the model directory, not the service's
    fallback labels. A fingerprint that reported those labels would call two
    different checkpoints the same, or the same checkpoint two names.
    Missing files yield nothing — the caller keeps its fallback.
    """
    if not model_dir:
        return {}
    try:
        if not os.path.isdir(model_dir):
            return {}
    except Exception:
        return {}

    found: dict = {}

    pooling_path = os.path.join(model_dir, "1_Pooling", "config.json")
    try:
        with open(pooling_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("pooling_mode_cls_token"):
            found["pooling"] = "cls"
        elif cfg.get("pooling_mode_mean_tokens"):
            found["pooling"] = "mean"
        elif cfg.get("pooling_mode_max_tokens"):
            found["pooling"] = "max"
        elif cfg.get("pooling_mode_mean_sqrt_len_tokens"):
            found["pooling"] = "mean_sqrt_len"
        dim = cfg.get("word_embedding_dimension")
        if isinstance(dim, int) and dim > 0:
            found["dim"] = dim
    except Exception:
        pass

    length_path = os.path.join(model_dir, "sentence_bert_config.json")
    try:
        with open(length_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        length = cfg.get("max_seq_length")
        if isinstance(length, int) and length > 0:
            found["max_length"] = length
    except Exception:
        pass

    tok_path = os.path.join(model_dir, "tokenizer_config.json")
    try:
        with open(tok_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        name = cfg.get("tokenizer_class")
        if isinstance(name, str) and name.strip():
            found["tokenizer"] = name.strip()
    except Exception:
        pass

    return found


def resolve_revision(model_dir: str | None, env_revision: str | None = None) -> str:
    """Revision for the fingerprint.

    EMBED_REVISION wins when non-empty; otherwise the first non-empty line
    of a revision file inside the model directory, when the model lives on
    disk. Anything else (remote name, missing file, blank) means "" —
    unconfirmed.
    """
    if env_revision is not None and str(env_revision).strip():
        return str(env_revision).strip()
    env_fallback = os.environ.get("EMBED_REVISION", "")
    if env_fallback.strip():
        return env_fallback.strip()
    if not model_dir:
        return ""
    # Remote HF names ("BAAI/bge-m3") are not directories — no file to read.
    try:
        if not os.path.isdir(model_dir):
            return ""
    except Exception:
        return ""
    for name in REVISION_FILES:
        path = os.path.join(model_dir, name)
        try:
            if not os.path.isfile(path):
                continue
            with open(path, "r", encoding="utf-8", errors="strict") as f:
                line = (f.readline() or "").strip()
            if line:
                return line
        except Exception:
            continue
    return ""
