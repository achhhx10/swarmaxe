# Troubleshooting

Always start with:

```bash
~/.config/opencode/patches/swarmaxe-doctor.sh
```

## A tool says "Unknown tool" / tools disappeared

1. `grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail`
2. `bun build --no-bundle --target=node ~/.config/opencode/plugins/swarmaxe.ts > /tmp/p.js && node --check /tmp/p.js`
3. `grep "setup(): .*outils" /tmp/swarmaxe-adapter.log | tail -3` — expect `92/92`.

If the log says `SyntaxError`, the adapter is invalid: restore the previous file
and fix before deploying (`bun build` does not validate regex literals; `node --check` does).

## Tools are slow again (~4 s)

The fast path is not active. Check `/tmp/swarmaxe-adapter.log` for
`inproc actif | 117 outils`. If absent:

- `SWARM_PKG_ENTRY` must point to a real `dist/index.js`
- `SWARM_INPROC` must not be `0`

## `SQLITE_BUSY`

```bash
grep -c "wal_checkpoint(TRUNCATE)" "$(npm root -g)/opencode-swarm-plugin/dist/bin/swarm.js"
```

Expected ≤ 2 (the explicit `checkpoint()` method only). If higher, re-apply the patches.

## Embeddings fail on long memories

```bash
curl -s http://127.0.0.1:11434/api/embed -d '{"model":"mxbai-embed-large","input":"hello","options":{"num_ctx":4096}}' | head -c 80
```

If that fails, Ollama is down or the model is missing. The old
`/api/embeddings` endpoint (512-token cap) must no longer be used by the CLI.

## `hive_sync` errors

Swarmaxe sets `auto_pull=false` and turns a failed `git push` into a warning.
A real failure means the export itself failed — check that the project has a
writable `.hive/` directory.

## Orphan processes

```bash
ps -eo pid,etime,command | grep "[s]warm tool"
```

The watchdog kills anything older than 2 h every 15 min
(`logs/watchdog.log`). The adapter itself caps each spawn at 180 s / 900 s.
