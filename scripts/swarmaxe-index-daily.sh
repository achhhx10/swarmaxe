#!/bin/bash
# swarm-index-daily.sh — alimente la memoire (cass/hivemind) avec l'historique
# OpenCode, de facon incrementale.
#
# 1. exporte/actualise les sessions terminees (>= 2 h) vers ~/.opencode/session-history
#    (reecriture seulement si le contenu change -> le mtime sert de marqueur)
# 2. lance hivemind_index, qui ignore les fichiers non modifies
#    (patch-swarm-indexer.py)
#
# Verrou simple pour ne jamais superposer deux passes.

set -uo pipefail
BASE="$HOME/.config/opencode/patches"
LOG="$HOME/.config/swarm-tools/logs/indexer.log"
LOCK="$HOME/.config/swarm-tools/.indexer.lock"
LIMIT="${SWARM_INDEX_LIMIT:-250}"
mkdir -p "$(dirname "$LOG")"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) deja en cours, abandon" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$(date -u +%FT%TZ) export (limit=$LIMIT)" >> "$LOG"
/usr/bin/env python3 "$BASE/index-sessions.py" --since 2026-08-01 --limit "$LIMIT" >> "$LOG" 2>&1

echo "$(date -u +%FT%TZ) index" >> "$LOG"
cd "$HOME/Desktop" || exit 0
swarm tool hivemind_index --json '{"full":false}' >> "$LOG" 2>&1
echo "$(date -u +%FT%TZ) termine" >> "$LOG"
