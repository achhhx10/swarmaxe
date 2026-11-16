#!/bin/bash
# swarmaxe-agents.sh — etat des agents que /swarm utilise.
#
# Les trois agents sont en `mode: subagent` : ils ne se selectionnent pas a la
# main, ils sont spawnes par la commande /swarm. Ce script verifie qu'ils sont
# installes, correctement nommes et dans le bon mode, et rappelle le point
# d'entree.

set -uo pipefail
OC="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
AG="$OC/agents"
fail=0

echo "commandes :"
for c in swarm analyse; do
  f="$OC/commands/$c.md"
  if [ -f "$f" ]; then
    case "$c" in
      swarm)   echo "  /swarm    presente — implementation (cells, workers, review)" ;;
      analyse) echo "  /analyse  presente — lecture seule (aucune modification)" ;;
    esac
  else
    echo "  /$c  ABSENTE"
    fail=$((fail + 1))
  fi
done
echo
printf "%-18s %-10s %-8s %s\n" "agent" "mode" "name" "etat"
for a in swarm-worker swarm-planner swarm-researcher swarm-analyst; do
  f="$AG/$a.md"
  if [ ! -f "$f" ]; then
    printf "%-18s %-10s %-8s %s\n" "$a" "-" "-" "ABSENT"
    fail=$((fail + 1))
    continue
  fi
  mode=$(sed -n 's/^mode: *//p' "$f" | head -1)
  name=$(sed -n 's/^name: *//p' "$f" | head -1)
  [ -z "$name" ] && name="$a"          # le nom du fichier fait office de nom
  state="ok"
  [ "$mode" != "subagent" ] && state="mode inattendu (attendu: subagent)"
  [ "$name" != "$a" ] && state="nom '$name' != nom de fichier"
  [ "$state" != "ok" ] && fail=$((fail + 1))
  printf "%-18s %-10s %-8s %s\n" "$a" "${mode:-?}" "$name" "$state"
done

echo
echo "Rappel : /swarm implemente (workers avec droits d'ecriture), /analyse comprend"
echo "(workers en lecture seule). Les selectionner a la main ne leur donne ni cellule"
echo "ni coordinateur — d'ou mode: subagent. Debug: passer temporairement en mode: all."
exit "$([ "$fail" -eq 0 ] && echo 0 || echo 1)"
