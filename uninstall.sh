#!/bin/bash
# uninstall.sh — retire swarmaxe. Les bases et memoires sont conservees sauf --purge.
set -euo pipefail
OC="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PATCHES="$OC/patches"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

for job in watchdog backup indexer; do
  launchctl bootout "gui/$(id -u)/ai.swarmaxe.$job" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/ai.swarmaxe.$job.plist"
done

rm -f "$OC/plugins/swarmaxe.ts" "$OC/swarmaxe-v1/legacy.ts" "$OC/lib/memory.ts" "$PATCHES/skill-forge.ts"
for f in swarmaxe-doctor.sh swarmaxe-agents.sh swarmaxe-watchdog.sh swarmaxe-backup.sh swarmaxe-index-daily.sh \
         index-sessions.py coverage-audit.py adapter-selftest.ts adapter-selftest.ts.bak \
         memory-selftest.ts swarmaxe-reembed.ts; do
  rm -f "$PATCHES/$f"
done
[ -f "$OC/plugins/swarm.ts.disabled-by-swarmaxe" ] && mv "$OC/plugins/swarm.ts.disabled-by-swarmaxe" "$OC/plugins/swarm.ts"

# agents + commandes : restaurer la version precedente si on en avait une
for f in "$OC"/agents/*.md.pre-swarmaxe; do
  [ -e "$f" ] && mv "$f" "${f%.pre-swarmaxe}"
done
for f in "$OC"/commands/*.md.pre-swarmaxe; do
  [ -e "$f" ] && mv "$f" "${f%.pre-swarmaxe}"
done

echo "swarmaxe retire. Bases conservees dans ~/.config/swarm-tools et ~/.local/share/opencode."
if [ "$PURGE" -eq 1 ]; then
  echo "--purge: suppression des sauvegardes ~/swarm-backups (les bases sont intactes)"
  rm -rf "$HOME/swarm-backups"
fi
echo "Les patchs de dist restent appliques (utiles au plugin seul). Pour revenir a l'amont:"
echo "  npm install -g opencode-swarm-plugin@0.63.2"
