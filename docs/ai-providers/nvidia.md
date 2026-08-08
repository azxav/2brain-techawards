# NVIDIA NIM embeddings

GBrain supports NVIDIA Llama Nemotron Embed through NVIDIA's OpenAI-compatible NIM embeddings endpoint.

## Setup

```bash
export NVIDIA_API_KEY=...
gbrain init --pglite --embedding-model nvidia:llama-nemotron-embed-1b-v2 --embedding-dimensions 2048
```

You can also persist the key in the file-plane config:

```bash
gbrain config set nvidia_api_key ...
gbrain config set embedding_model nvidia:llama-nemotron-embed-1b-v2
gbrain config set embedding_dimensions 2048
```

For an existing brain, do not change only `embedding_model`. The primary embedding column must match both the model output width and the storage type:

```bash
gbrain reinit-pglite --embedding-model nvidia:llama-nemotron-embed-1b-v2 --embedding-dimensions 2048
```

Postgres users should follow the recipe from `gbrain doctor` or `docs/embedding-migrations.md`; the target column for the default NVIDIA setup is `halfvec(2048)`.

## Model contract

- Friendly model id: `nvidia:llama-nemotron-embed-1b-v2`
- Wire model id: `nvidia/llama-nemotron-embed-1b-v2`
- Base URL: `https://integrate.api.nvidia.com/v1`
- Required env: `NVIDIA_API_KEY`
- Default output dimensions: `2048`
- Allowed output dimensions: `384`, `512`, `768`, `1024`, or `2048`
- Max input: `8192` tokens
- Document/indexing input type: `passage`
- Query input type: `query`

GBrain sends `input_type: "passage"` for document embeddings and `input_type: "query"` for `embedQuery()` calls. It also sends the configured `dimensions` value so NVIDIA returns vectors that match the brain schema.

## pgvector storage

The default NVIDIA setup uses `halfvec(2048)` for `content_chunks.embedding`. That keeps the primary HNSW index available at 2048 dimensions:

```sql
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding halfvec_cosine_ops);
```

Other providers still use `vector(N)` unless their schema policy explicitly opts into `halfvec`.
