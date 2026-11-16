#!/bin/bash
# install.sh — installe swarmaxe par-dessus opencode-swarm-plugin.
#
#   ./install.sh                 installation complete (patchs + jobs + verification)
#   ./install.sh --dry-run       affiche ce qui serait fait
#   ./install.sh --no-launchd    pas de jobs planifies (macOS/Linux)
#   ./install.sh --no-verify     pas de doctor en fin d'installation
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PATCHES="$OC/patches"
VERSION="${SWARM_PLUGIN_VERSION:-0.63.2}"
DRY=0; NO_LAUNCHD=0; NO_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-launchd) NO_LAUNCHD=1 ;;
    --no-verify) NO_VERIFY=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "argument inconnu: $arg" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" -eq 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
say() { echo "== $*"; }

say "prerequis"
for bin in node npm bun python3; do
  command -v "$bin" >/dev/null || { echo "manquant: $bin" >&2; exit 1; }
done
node -e 'const m=+process.versions.node.split(".")[0]; process.exit(m>=20?0:1)' || {
  echo "Node >= 20 requis" >&2; exit 1
}

say "paquet amont: opencode-swarm-plugin@$VERSION"
if [ "$DRY" -eq 0 ]; then
  installed="$(npm ls -g --depth=0 opencode-swarm-plugin 2>/dev/null | sed -n 's/.*opencode-swarm-plugin@\([0-9.]*\).*/\1/p' | head -1)"
  if [ "$installed" != "$VERSION" ]; then
    npm install -g "opencode-swarm-plugin@$VERSION"
  fi
  PKG="$(npm root -g)/opencode-swarm-plugin"
  [ -f "$PKG/dist/index.js" ] || { echo "installation amont incomplete: $PKG/dist/index.js" >&2; exit 1; }
fi

say "dossiers"
run "mkdir -p '$OC/plugins' '$OC/swarmaxe-v1' '$OC/lib' '$PATCHES' '$OC/skills'"

if [ -f "$OC/plugins/swarm.ts" ]; then
  echo "  ! un ancien adaptateur swarm.ts existe: il sera desactive (renomme .disabled-by-swarmaxe)"
  run "mv '$OC/plugins/swarm.ts' '$OC/plugins/swarm.ts.disabled-by-swarmaxe'"
fi

say "copie des fichiers"
run "cp '$HERE/src/adapter/swarmaxe.ts' '$OC/plugins/swarmaxe.ts'"
run "cp '$HERE/src/adapter/legacy.ts' '$OC/swarmaxe-v1/legacy.ts'"
run "cp '$HERE/src/lib/skill-forge.ts' '$PATCHES/skill-forge.ts'"
run "cp '$HERE/src/lib/memory.ts' '$OC/lib/memory.ts'"
for f in swarmaxe-doctor.sh swarmaxe-agents.sh swarmaxe-watchdog.sh swarmaxe-backup.sh swarmaxe-index-daily.sh \
         swarmaxe-memory-sync.sh index-sessions.py coverage-audit.py adapter-selftest.ts memory-selftest.ts \
         swarmaxe-reembed.ts swarmaxe-memory-export.ts swarmaxe-memory-import.ts; do
  run "cp '$HERE/scripts/$f' '$PATCHES/$f'"
  run "chmod 755 '$PATCHES/$f'"
done

say "agents + commandes (/swarm, /analyse)"
run "mkdir -p '$OC/agents' '$OC/commands'"
for src in "$HERE"/agents/*.md; do
  a="$(basename "$src")"
  if [ -f "$OC/agents/$a" ] && [ ! -f "$OC/agents/$a.pre-swarmaxe" ] && ! cmp -s "$src" "$OC/agents/$a"; then
    run "cp '$OC/agents/$a' '$OC/agents/$a.pre-swarmaxe'"
  fi
  run "cp '$src' '$OC/agents/$a'"
done
for src in "$HERE"/commands/*.md; do
  c="$(basename "$src")"
  if [ -f "$OC/commands/$c" ] && [ ! -f "$OC/commands/$c.pre-swarmaxe" ] && ! cmp -s "$src" "$OC/commands/$c"; then
    run "cp '$OC/commands/$c' '$OC/commands/$c.pre-swarmaxe'"
  fi
  run "cp '$src' '$OC/commands/$c'"
done

say "patchs du paquet amont"
run "python3 '$HERE/src/patches/patch-swarm-plugin.py'"
run "python3 '$HERE/src/patches/patch-swarm-indexer.py'"

if [ "$NO_LAUNCHD" -eq 0 ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    say "jobs launchd"
    for job in watchdog backup indexer sync; do
      src="$HERE/launchd/ai.swarmaxe.$job.plist"
      dst="$HOME/Library/LaunchAgents/ai.swarmaxe.$job.plist"
      run "sed 's|__HOME__|$HOME|g; s|__PATCHES__|$PATCHES|g' '$src' > '$dst'"
      run "launchctl bootout gui/$(id -u)/ai.swarmaxe.$job 2>/dev/null || true"
      run "launchctl bootstrap gui/$(id -u) '$dst'"
    done
  else
    say "jobs cron (Linux)"
    cat <<CRON
Ajoute ces lignes a `crontab -e` :
  15 4,13 * * * /bin/bash $PATCHES/swarmaxe-index-daily.sh
  */15 * * * * /bin/bash $PATCHES/swarmaxe-watchdog.sh
  30 3 * * 0   /bin/bash $PATCHES/swarmaxe-backup.sh
CRON
  fi
fi

if [ "$NO_VERIFY" -eq 0 ] && [ "$DRY" -eq 0 ]; then
  say "verification"
  bash "$PATCHES/swarmaxe-doctor.sh" --quick || {
    echo "!! le doctor a echoue. Consulte docs/TROUBLESHOOTING.md" >&2; exit 1
  }
fi

say "termine"
echo "Redemarre le service OpenCode si les outils n'apparaissent pas: opencode service restart"
echo "Puis: $PATCHES/swarmaxe-doctor.sh"
