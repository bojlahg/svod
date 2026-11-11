"""
Stage 5 contract without weights/torch: canonical fingerprint + query priority.

Run:  python test_stage5.py   (from services/embed/)
`npm test` does not see this file; the executor attaches its output.
"""

import hashlib
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))

from fingerprint import (
    FINGERPRINT_FIELDS,
    build_fingerprint,
    canonical_fingerprint_json,
    checkpoint_settings,
    fingerprint_id,
    resolve_revision,
)
from infer_queue import PrioritySchedule


def check_canonical_order() -> None:
    fields = {
        "dim": 1024,
        "passage_prefix": "",
        "query_prefix": "",
        "max_length": 8192,
        "normalize": True,
        "pooling": "cls",
        "tokenizer": "bge-m3",
        "revision": "5617a9f61b028005a4858fdac845db406aefb181",
        "model": "/models/bge-m3",
    }
    canonical = canonical_fingerprint_json(fields)
    # Keys in the spec order, compact separators, no ASCII escaping.
    parsed_keys = list(json.loads(canonical).keys())
    assert parsed_keys == FINGERPRINT_FIELDS, f"order: {parsed_keys}"
    assert canonical == json.dumps(
        {k: fields[k] for k in FINGERPRINT_FIELDS},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    # Independent SHA-256 check.
    assert fingerprint_id(canonical) == hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    print(f"canonical ok: {canonical[:80]}… id={fingerprint_id(canonical)[:12]}…")


def check_thread_gpu_excluded() -> None:
    base = {
        "model": "m",
        "revision": "r",
        "tokenizer": "t",
        "pooling": "cls",
        "normalize": True,
        "max_length": 100,
        "query_prefix": "",
        "passage_prefix": "",
        "dim": 4,
    }
    a = fingerprint_id(canonical_fingerprint_json(base))
    # Threads / device / batch size must not enter the hash: extra keys ignored.
    b = fingerprint_id(
        canonical_fingerprint_json({**base, "threads": 4, "device": "cuda", "batch": 8})  # type: ignore[typeddict-item]
    )
    assert a == b, "non-fingerprint settings leaked into the id"
    print(f"exclusion ok: id={a[:12]}…")


def check_confirmed_needs_revision() -> None:
    good = build_fingerprint(
        {
            "model": "m",
            "revision": "abc123",
            "tokenizer": "t",
            "pooling": "cls",
            "normalize": True,
            "max_length": 8,
            "query_prefix": "",
            "passage_prefix": "",
            "dim": 2,
        }
    )
    bad = build_fingerprint({**good["fields"], "revision": ""})
    assert good["confirmed"] is True
    assert bad["confirmed"] is False
    assert good["id"] != bad["id"], "empty revision must change the id"
    print(f"confirmed ok: {good['id'][:12]}… vs unconfirmed {bad['id'][:12]}…")


def check_revision_sources() -> None:
    with tempfile.TemporaryDirectory() as d:
        # ENV wins over the file.
        with open(os.path.join(d, "revision.txt"), "w", encoding="utf-8") as f:
            f.write("from-file\n")
        assert resolve_revision(d, "from-env") == "from-env"
        old = os.environ.get("EMBED_REVISION")
        try:
            os.environ.pop("EMBED_REVISION", None)
            assert resolve_revision(d) == "from-file"
            assert resolve_revision(d + "-missing") == ""
        finally:
            if old is not None:
                os.environ["EMBED_REVISION"] = old
    print("revision ok: env > file > empty")


def check_checkpoint_settings() -> None:
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "1_Pooling"))
        with open(os.path.join(d, "1_Pooling", "config.json"), "w", encoding="utf-8") as f:
            json.dump(
                {
                    "word_embedding_dimension": 1024,
                    "pooling_mode_cls_token": True,
                    "pooling_mode_mean_tokens": False,
                },
                f,
            )
        with open(os.path.join(d, "sentence_bert_config.json"), "w", encoding="utf-8") as f:
            json.dump({"max_seq_length": 8192}, f)
        with open(os.path.join(d, "tokenizer_config.json"), "w", encoding="utf-8") as f:
            json.dump({"tokenizer_class": "XLMRobertaTokenizer"}, f)
        got = checkpoint_settings(d)
        assert got["pooling"] == "cls"
        assert got["dim"] == 1024
        assert got["max_length"] == 8192
        assert got["tokenizer"] == "XLMRobertaTokenizer"
        assert checkpoint_settings(d + "-missing") == {}
    print("checkpoint ok: pooling, length, tokenizer and dim come from the files")


def check_query_priority() -> None:
    q = PrioritySchedule()
    q.push("passage", "p1")
    q.push("passage", "p2")
    q.push("query", "q1")
    # Query jumps ahead of the next waiting passage even though it arrived last.
    assert q.peek_kind() == "query"
    order = [q.pop()[1], q.pop()[1], q.pop()[1]]
    assert order == ["q1", "p1", "p2"], f"order: {order}"
    # FIFO inside each lane.
    r = PrioritySchedule()
    r.push("query", "a")
    r.push("query", "b")
    r.push("passage", "c")
    assert [r.pop()[1], r.pop()[1], r.pop()[1]] == ["a", "b", "c"]
    print("priority ok: query before next passage, FIFO inside lanes")


def main() -> int:
    check_canonical_order()
    check_thread_gpu_excluded()
    check_confirmed_needs_revision()
    check_revision_sources()
    check_checkpoint_settings()
    check_query_priority()
    print("stage5 python contract: OK (6 checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
