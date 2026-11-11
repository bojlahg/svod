#!/usr/bin/env bash
# Fetch a model into a local directory.
#
# Two problems this works around, both specific to flaky routes to the HF CDN:
#
#   1. huggingface_hub stalls on the LFS CDN — small files land, the GB-sized
#      weights sit at zero bytes forever with no error.
#   2. `curl --retry -C -` makes it worse, not better: when the CDN ignores
#      Range on a retry it replies 200 with the whole body and curl truncates
#      the partial file. The download then walks backwards.
#
# So the big file is fetched with explicit Range requests appended to the file,
# and a 200 (ignored Range) is rejected rather than written. Progress can only
# go forwards; interrupt and re-run as often as you like.
#
#   ./fetch-model.sh              # resume bge-m3 into ./models/bge-m3
#   ./fetch-model.sh reranker     # bge-reranker-v2-m3 into ./models/bge-reranker-v2-m3
#   ./fetch-model.sh reranker /tmp/x   # second argument overrides the directory
#
# The destination comes from the target, not from a DEST in the environment.
# The image sets DEST for its own boot fetch, and honouring that here sent the
# reranker's weights into the embedding model's directory — where transformers
# then preferred them and would have loaded a cross-encoder as the embedder.
#   MIRROR=1 ./fetch-model.sh     # go through hf-mirror.com instead
set -uo pipefail
cd "$(dirname "$0")"

TARGET="${1:-bge-m3}"
HOST="https://huggingface.co"
[ "${MIRROR:-0}" = "1" ] && HOST="https://hf-mirror.com"
# Pinned checkpoint for reproducible fingerprints (stage 5). Override with
# EMBED_REVISION=... to move deliberately; empty means "main" (unconfirmed).
PINNED_REVISION="5617a9f61b028005a4858fdac845db406aefb181"
REVISION="${EMBED_REVISION:-$PINNED_REVISION}"
if [ -z "$REVISION" ]; then
  REVISION="main"
fi

case "$TARGET" in
  bge-m3)
    REPO="BAAI/bge-m3"
    DEST="${2:-./models/bge-m3}"
    ENV_VAR="EMBED_MODEL"
    SMALL=(
      "1_Pooling/config.json"
      "config.json"
      "config_sentence_transformers.json"
      "modules.json"
      "sentence_bert_config.json"
      "special_tokens_map.json"
      "tokenizer_config.json"
      "tokenizer.json"
      "sentencepiece.bpe.model"
    )
    ;;
  reranker|bge-reranker-v2-m3)
    # Plain CrossEncoder checkpoint — no sentence-transformers module configs,
    # so the file list is just tokenizer + config. Weights ship as safetensors
    # here, not pytorch_model.bin: asking for the wrong one 404s, and if the
    # directory already holds an embedding model's files the loader quietly
    # builds a randomly-initialised classifier head and scores everything at
    # ~0.5 — worse than no reranker, because search still reorders by it.
    REPO="BAAI/bge-reranker-v2-m3"
    WEIGHTS="model.safetensors"
    DEST="${2:-./models/bge-reranker-v2-m3}"
    ENV_VAR="RERANK_MODEL"
    SMALL=(
      "config.json"
      "special_tokens_map.json"
      "tokenizer_config.json"
      "tokenizer.json"
      "sentencepiece.bpe.model"
    )
    ;;
  *)
    echo "unknown target '$TARGET' — expected 'bge-m3' or 'reranker'" >&2
    exit 1
    ;;
esac
LARGE="${WEIGHTS:-pytorch_model.bin}"

size_of() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }

mkdir -p "$DEST"
echo "→ $REPO into $DEST (via ${HOST#https://})"

for f in "${SMALL[@]}"; do
  out="$DEST/$f"
  mkdir -p "$(dirname "$out")"
  if [ -s "$out" ]; then
    printf '  %-40s cached\n' "$f"
    continue
  fi
  printf '  %-40s ' "$f"
  if curl -fsSL --retry 5 --retry-delay 3 --connect-timeout 20 \
       -o "$out" "$HOST/$REPO/resolve/$REVISION/$f"; then
    echo "ok ($(du -h "$out" | cut -f1))"
  else
    rm -f "$out"
    echo "FAILED — re-run to retry"
    exit 1
  fi
done

# ─── the big one ─────────────────────────────────────────────────────────────

url="$HOST/$REPO/resolve/$REVISION/$LARGE"
out="$DEST/$LARGE"
touch "$out"

total=$(curl -fsSLI --connect-timeout 20 "$url" \
  | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {v=$2} END {gsub(/\r/,"",v); print v+0}')

if [ "${total:-0}" -lt 1000000 ]; then
  echo "  could not determine size of $LARGE (got '${total:-}')" >&2
  exit 1
fi

echo "  $LARGE — $((total / 1024 / 1024)) MB total"

stall=0
while :; do
  have=$(size_of "$out")
  [ "$have" -ge "$total" ] && break

  pct=$((have * 100 / total))
  printf '\r    %3d%%  %s / %s MB  ' "$pct" "$((have / 1024 / 1024))" "$((total / 1024 / 1024))"

  code=$(curl -sS --connect-timeout 20 --max-time 900 \
           --speed-limit 2048 --speed-time 60 \
           -H "Range: bytes=${have}-" \
           -w '%{http_code}' -o /tmp/mozg-chunk.bin -L "$url" 2>/dev/null)

  chunk=$(size_of /tmp/mozg-chunk.bin)

  # 206 = the server honoured Range, so the chunk continues our file.
  # 200 = it ignored Range and sent everything; appending would corrupt.
  if [ "$code" = "206" ] && [ "$chunk" -gt 0 ]; then
    cat /tmp/mozg-chunk.bin >> "$out"
    stall=0
  elif [ "$code" = "200" ] && [ "$have" -eq 0 ] && [ "$chunk" -gt 0 ]; then
    mv /tmp/mozg-chunk.bin "$out"
    stall=0
  else
    stall=$((stall + 1))
    if [ "$stall" -ge 30 ]; then
      echo
      echo "  stalled after 30 attempts (last HTTP $code). File kept at $(size_of "$out") bytes —"
      echo "  re-run this script to continue from there."
      exit 1
    fi
    sleep 3
  fi
  rm -f /tmp/mozg-chunk.bin
done

printf '\r    100%%  %s MB          \n' "$((total / 1024 / 1024))"
echo "$REVISION" > "$DEST/revision.txt"
echo
echo "✓ model ready (revision $REVISION). Point the service at it:"
echo "    $ENV_VAR=$(cd "$DEST" && pwd)"
