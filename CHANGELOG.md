# Changelog

## 0.1.1 — 2026-11-16

Memory retention fix.

- `hivemind_store` no longer loses text when the embedding fails: the memory is
  stored with a pending vector and re-embedded by the watchdog within 15 minutes.
- The embedding budget now follows the model context: 512 tokens ≈ 1 200
  characters, 150-character overlap. The previous thresholds (6 000 characters
  for the CLI, 24 000 for the in-process path) were far beyond that limit, which
  is why long entries failed with `Failed to generate embedding`.
- The in-process path (`swarm-mail`, the one the plugin actually uses) now gets
  the same patches as the CLI: `/api/embed`, `num_ctx 512`, 1 200-character
  chunking, fail-open insert.
- Long entries are split into linked memories (`metadata.parent_id`, `part`,
  `parts`) so each part receives its own vector; `hivemind_find` merges vector
  and full-text results while a vector is pending.
- New `swarmaxe-reembed.ts` repairs existing rows (668 in the local database:
  9 without a vector, 659 above the budget). Idempotent, resumable, non-destructive.
- Doctor: long-memory round-trip on the in-process path, patch checks for
  `swarm-mail`, and counts of missing or oversized vectors.

## 0.1.0 — 2026-11-15

First public release.

- Adapter for OpenCode 2.x: 92 tools registered, upstream ones included.
- In-process execution for an allowlisted set (p50 2–5 ms, CLI fallback).
- Bounded spawns (180 s / 900 s) with SIGKILL; watchdog for orphans.
- Dist patches: `/api/embed` + `num_ctx`, chunk 6 000, no TRUNCATE checkpoint,
  no `auto_vacuum` replay, `busy_timeout` 15 s, incremental session indexer.
- Memory pipeline: OpenCode sessions → condensed, redacted JSONL → cass/hivemind.
- Skill Forge: `skill_forge` (strict template, secrets blocked, dry-run default)
  and `skill_curate` (mines memories for recurring themes).
- Doctor (30 checks), adapter self-test, tool-coverage audit.
- Ops: watchdog, indexer (2×/day), coherent backups (weekly, 3-copy rotation).
