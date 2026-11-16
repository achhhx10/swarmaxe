# Architecture

```
agent
  └─ OpenCode tool call
       └─ swarmaxe.ts (V2 adapter, 92 tools)
            ├─ in-process allowlist ──► dist/index.js (upstream, 117 tools)
            │      p50 2–5 ms, one DB connection, adapter cache
            └─ everything else ───────► `swarm tool <name>` CLI spawn
                   heavy only: tsc/bun test, decomposition, review, worktrees
```

## Why in-process

The stock wrapper shells out for **every** tool: a new process parses a 16 MB
bundle, opens libSQL, runs migrations, answers, dies. That costs ~4 s and
serialises under load (29 s for 8 parallel calls).

The package already ships the real implementations in `dist/index.js`
(`SwarmPlugin`, MIT). Swarmaxe imports that bundle once and calls
`tool[name].execute()` directly. The generated wrapper is kept for its schemas
and for the CLI fallback.

## Safety model

| Risk | Mitigation |
|---|---|
| Bad tool blocks the event loop | allowlist excludes heavy tools; 300 s call cap |
| Bundle missing/incompatible after upgrade | lazy import, 20 s cap, automatic CLI fallback |
| Writes executed twice | no CLI retry after an execution error |
| Plugin reload breaks silently | self-test asserts p50 and output, doctor fails on regression |
| Tool name drift after upgrade | coverage audit compares adapter vs upstream vs CLI |

`SWARM_INPROC=0` disables the fast path. `SWARM_PKG_ENTRY` repoints the bundle.

## SQLite

One database (`~/.config/swarm-tools/swarm.db`) is shared by cells, memories,
reservations and mail. The patches remove `PRAGMA auto_vacuum` and
`wal_checkpoint(TRUNCATE)` from the connection open path (they need the write
lock on every call), keep `journal_mode=WAL`, and raise `busy_timeout` to 15 s.
Adapter retries run 0.5→8 s so they can outlast the timeout.

## Skill Forge (governance)

`skill_forge` refuses:

- names that are not kebab-case, descriptions outside 20–200 chars
- missing `When NOT to use` or missing executable verification
- duplicates (unless `overwrite`), secrets (7 patterns), scripts that do not parse
- bodies over 20 KB

`commit:false` is the default: the tool renders and validates, the agent decides.
`skill_curate` mines memories for tags that recur, and returns draft specs — it
never writes.

Why governance first: a generator without a validator produces skill sprawl that
*degrades* retrieval. The value is in the constraints, not the generation.
