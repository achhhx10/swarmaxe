# Install

## Requirements

| Tool | Version | Why |
|---|---|---|
| Node | ≥ 20 | OpenCode service |
| Bun | any recent | plugin runtime + CLI spawn |
| Python | ≥ 3.9 | patcher, indexer, doctor |
| OpenCode | 2.x | plugin API |
| Ollama | optional | semantic memory (`mxbai-embed-large`) |

## Steps

```bash
git clone https://github.com/achhhx10/swarmaxe.git
cd swarmaxe
./install.sh --dry-run     # inspect first
./install.sh
```

What it does:

1. Installs `opencode-swarm-plugin@0.63.2` globally (pinned: the patches are version-specific).
2. Copies the adapter to `~/.config/opencode/plugins/swarmaxe.ts` and the wrapper to
   `~/.config/opencode/swarmaxe-v1/legacy.ts`.
3. Copies the Skill Forge, doctor, indexer, watchdog and backup to
   `~/.config/opencode/patches/`.
4. Installs the four swarm agents and both commands (`/swarm`, `/analyse`)
   (`~/.config/opencode/agents`, `~/.config/opencode/commands`), keeping a
   `*.pre-swarmaxe` copy of anything it replaces.
5. Applies the two idempotent `dist` patches (embeddings, SQLite locking, incremental index).
6. Installs three scheduled jobs (launchd on macOS, cron lines printed on Linux).
7. Runs `swarmaxe-doctor.sh --quick`.

If an older `swarm.ts` adapter exists, the installer renames it to
`swarm.ts.disabled-by-swarmaxe` so the tools are not registered twice.

## After install

```bash
~/.config/opencode/patches/swarmaxe-doctor.sh
opencode service restart     # only if tools do not appear in a new session
```

## Ollama (semantic memory)

```bash
ollama pull mxbai-embed-large
printf 'FROM mxbai-embed-large:latest\nPARAMETER num_ctx 4096\n' > /tmp/Modelfile
ollama create mxbai-embed-large:8k -f /tmp/Modelfile
```

Swarmaxe calls `/api/embed` with `num_ctx` explicitly, so the tag name is not
required; the model must simply exist locally.

## Uninstall

```bash
./uninstall.sh          # keeps databases, memories and sessions
./uninstall.sh --purge  # also removes ~/swarm-backups
```
