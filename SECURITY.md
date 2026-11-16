# Security policy

## What is never committed

- `swarm.db`, `opencode.db`, any `*.db`, `*.db-wal`, `*.db-shm`
- `auth.json`, `service.json`, `credential*`, `*.pem`, `*.key`
- `.env`, `.env.*`
- logs (`*.log`), session exports, memory dumps
- any value matching an API-key or private-key pattern

`install.sh` does not send anything anywhere; the only network calls are
`npm install -g` for the pinned upstream package.

## Data handling

- `scripts/index-sessions.py` reads `opencode.db` **read-only**, condenses each
  session, redacts common secret shapes (keys, tokens, private keys) and writes
  the result under `~/.opencode/session-history` (mode 700).
- Embeddings are computed locally by Ollama. No content leaves the machine
  unless you configured a remote Ollama host yourself.
- The doctor and the self-test print tool names and timings, never tool content.

## Reporting

Open an issue with the output of `swarmaxe-doctor.sh --quick` after removing
hostnames, paths and any token. Do not paste `swarm.db` content.
