#!/bin/bash
# swarm-watchdog.sh — tue les CLI `swarm tool ...` orphelins.
#
# Un appel d'outil interrompu (annulation, redemarrage du service) laissait un
# processus `swarm tool` tourner indefiniment : un cas mesure a tourne 8 h 42
# pour 414 minutes de CPU. L'adaptateur borne desormais chaque spawn, ce
# watchdog couvre les cas restants (service tue, SIGKILL du parent, etc.).
#
# Seuil volontairement large : les outils lourds (swarm_review, swarm_verify)
# peuvent legitimement durer plusieurs minutes (tsc + bun test).

set -u
MAX_SECONDS=${MAX_SECONDS:-7200}   # 120 min (laisse finir les indexations longues)
LOG="$HOME/.config/swarm-tools/logs/watchdog.log"
mkdir -p "$(dirname "$LOG")"

now=$(date -u +%FT%TZ)

ps -eo pid,etime,command | awk '/[s]warm tool /{print $1, $2}' | while read -r pid etime; do
  # etime = [[dd-]hh:]mm:ss
  secs=$(printf '%s\n' "$etime" | awk -F'-' '{
      days = (NF == 2) ? $1 : 0;
      rest = (NF == 2) ? $2 : $1;
      n = split(rest, a, ":");
      if (n == 3) s = a[1] * 3600 + a[2] * 60 + a[3];
      else if (n == 2) s = a[1] * 60 + a[2];
      else s = a[1];
      print days * 86400 + s;
    }')
  case "$secs" in ''|*[!0-9]*) continue ;; esac
  if [ "$secs" -gt "$MAX_SECONDS" ]; then
    cmd=$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-120)
    if kill -9 "$pid" 2>/dev/null; then
      echo "$now killed pid=$pid age=${secs}s cmd=$cmd" >> "$LOG"
    fi
  fi
done

# Reprise des memoires dont l'embedding a echoue (fail-open) : quelques
# entrees par tick, pour ne pas saturer Ollama ni la base.
REEMBED="$HOME/.config/opencode/patches/swarmaxe-reembed.ts"
if [ -f "$REEMBED" ] && command -v bun >/dev/null 2>&1; then
  nice -n 15 bun "$REEMBED" --null-only --limit 2 --max-load 6 >> "$HOME/.config/swarm-tools/logs/reembed.log" 2>&1 || true
fi

exit 0
