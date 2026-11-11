FROM python:3.12-slim

WORKDIR /srv

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# CPU-only torch: the GPU build is several GB larger and this workload is a few
# hundred embeddings a minute at most. The pin stays in sync with
# requirements.txt — the CPU index serves it as 2.6.0+cpu, which ==2.6.0
# matches (local versions are ignored), so the requirements pass below sees
# torch as already satisfied instead of pulling the GPU wheel from PyPI.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.6.0 \
 && pip install --no-cache-dir -r requirements.txt

COPY main.py fingerprint.py fetch-model.sh ./
RUN chmod +x fetch-model.sh

# Weights live in a volume, not the image: 2.2 GB in a layer makes every deploy
# slow and every registry push painful.
ENV EMBED_MODEL=/models/bge-m3

# Optional cross-encoder for search reranking. Not fetched on boot — pull it
# deliberately (`./fetch-model.sh reranker` against the models volume). Until
# it is there, /rerank answers 503 and search falls back to plain RRF.
ENV RERANK_MODEL=/models/bge-reranker-v2-m3

EXPOSE 8099

# Fetch on first boot if the volume is empty, then serve.
CMD ["sh", "-c", "[ -s /models/bge-m3/pytorch_model.bin ] || ./fetch-model.sh bge-m3 /models/bge-m3; exec uvicorn main:app --host 0.0.0.0 --port 8099"]
