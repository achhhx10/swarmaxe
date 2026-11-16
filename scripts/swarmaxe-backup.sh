#!/bin/bash
# swarm-backup.sh — sauvegarde hebdomadaire des deux bases critiques.
#
#   ~/.config/swarm-tools/swarm.db      memoires, cellules, reservations (272 Mo)
#   ~/.local/share/opencode/opencode.db sessions et messages          (~4 Go)
#
# Utilise l'API de sauvegarde SQLite (python) et non `cp` : elle est coherente
# meme avec le WAL actif et une base ouverte en ecriture.
# Rotation : 3 copies par base. opencode.db est saute si l'espace libre < 20 Go.

set -uo pipefail
DEST="${SWARM_BACKUP_DIR:-$HOME/swarm-backups}"
LOG="$HOME/.config/swarm-tools/logs/backup.log"
KEEP=3
mkdir -p "$DEST" "$(dirname "$LOG")"
STAMP=$(date +%Y%m%d-%H%M%S)

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

backup() {
  local src="$1" label="$2"
  [ -f "$src" ] || { log "skip $label (absent)"; return 0; }
  local out="$DEST/$label-$STAMP.db"
  if python3 - "$src" "$out" <<'PY'
import sqlite3, sys
src, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=60)
dst = sqlite3.connect(out)
with dst:
    con.backup(dst)
dst.close(); con.close()
PY
  then
    log "ok $label -> $out ($(du -h "$out" | cut -f1))"
  else
    log "ECHEC $label"
    rm -f "$out"
  fi
  ls -1t "$DEST/$label"-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"; log "rotation $old"
  done
}

free_gb=$(df -g / | awk 'NR==2 {print $4}')
if [ "${free_gb:-0}" -lt 20 ]; then
  log "espace libre ${free_gb}G < 20G : opencode.db ignore"
else
  backup "$HOME/.local/share/opencode/opencode.db" "opencode"
fi
backup "$HOME/.config/swarm-tools/swarm.db" "swarm"

log "termine (libre ${free_gb}G)"
