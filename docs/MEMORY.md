# Memory pipeline

Swarm memory is only useful if it covers your real work. Upstream indexes its own
25 session files (264 KB); the actual history lives in OpenCode's database.

```
opencode.db (read-only)
   └─ index-sessions.py ──► ~/.opencode/session-history/<session>.jsonl
                              (condensed, secrets redacted, mode 600/700)
                                 └─ hivemind_index ──► swarm.db (memories + vectors)
                                                          └─ cass_search / hivemind_find
```

## Properties

- **Idempotent**: chunk id is `<session_id>-<n>`; the store is an upsert.
- **Incremental**: `index-state.json` keeps `path -> {mtimeMs, chunks}`; unchanged
  files are skipped (patch `patch-swarm-indexer.py`, because the CLI re-embeds
  everything on every call).
- **Bounded**: only sessions settled for ≥ 2 h; 1–2 chunks per session, ≤ 3 000 chars.
- **Redacted**: API keys, tokens, JWTs and private keys are replaced before writing.

## Cost

Embedding is ~3 s per 1 000 characters on a CPU-only Mac. 400 sessions ≈ 1 M
characters ≈ 1 h, one time. Afterwards the twice-daily job only handles new
sessions.

## Embedding budget and retention

The local embedding model (`mxbai-embed-large`) has a 512-token context — about
1 200 characters of French or English. Anything longer is not sent whole:

- **Split** — `splitForEmbedding()` cuts on paragraph and sentence boundaries
  into parts of at most 1 200 characters, with 150 characters of overlap.
- **Linked parts** — one memory per part, carrying `metadata.parent_id`, `part`
  and `parts`. Each part gets its own vector, so a long note stays searchable.
- **Fail-open** — if Ollama is down or times out, the text is still stored (the
  vector stays `NULL`) and the watchdog re-embeds it with
  `swarmaxe-reembed.ts --null-only` within 15 minutes. No memory is discarded.
- **Hybrid search** — `hivemind_find` merges full-text hits with vector hits, so
  a pending memory remains findable by its exact content.
- **Repair** — `swarmaxe-reembed.ts --over-budget` recomputes vectors written
  before this budget existed; content and ids are unchanged. The script is
  resumable and refuses to run while the machine is saturated
  (`--max-load`, default 6): it is better to wait than to starve Ollama.

`SWARMAXE_EMBED_MAX_CHARS` (default 1200) and `SWARMAXE_EMBED_NUM_CTX`
(default 512) adapt the budget to another model; re-run
`src/patches/patch-swarm-plugin.py` after changing them.

## Restore on another machine

The knowledge bundle contains `memories.jsonl`, `cells.jsonl` and (optionally)
the full databases. See its `README-RESTORE.md`.
