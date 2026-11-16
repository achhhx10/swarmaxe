#!/bin/bash
# swarmaxe-memory-sync.sh — synchronisation quotidienne des memoires entre Macs.
#
# Un fichier JSONL par machine dans $SWARM_SYNC_DIR (~/SwarmSync par defaut).
# Chaque Mac n'ecrit que le sien : deux machines peuvent synchroniser en meme
# temps sans se ecraser. Les vecteurs ne voyagent pas : ils sont recalculés
# localement apres import.
#
#   bash swarmaxe-memory-sync.sh
#   SWARM_SYNC_DIR=~/Library/Mobile\ Documents/... bash swarmaxe-memory-sync.sh

set -uo pipefail
DIR="${SWARM_SYNC_DIR:-$HOME/SwarmSync}"
PATCHES="${SWARMAXE_PATCHES:-$HOME/.config/opencode/patches}"
LOG="${SWARM_SYNC_LOG:-$HOME/.config/swarm-tools/logs/sync.log}"
mkdir -p "$DIR" "$(dirname "$LOG")"

now() { date -u +%FT%TZ; }
say() { echo "$(now) $*" | tee -a "$LOG"; }

if ! command -v bun >/dev/null 2>&1; then
  say "bun introuvable : synchronisation abandonnee"
  exit 1
fi

say "== sync demarree (dir=$DIR)"
if ! bun "$PATCHES/swarmaxe-memory-export.ts" --dir "$DIR" 2>>"$LOG" | tee -a "$LOG"; then
  say "export echoue"
  exit 1
fi
if ! bun "$PATCHES/swarmaxe-memory-import.ts" --dir "$DIR" 2>>"$LOG" | tee -a "$LOG"; then
  say "import echoue"
  exit 1
fi

# Vectorise les memoires importees (embedding NULL) sans saturer la machine.
if ! bun "$PATCHES/swarmaxe-reembed.ts" --null-only --max-load 6 2>>"$LOG" | tee -a "$LOG"; then
  say "reembed partiel (relancer plus tard : monitoring dans reembed.log)"
fi

say "== sync terminee"
exit 0
