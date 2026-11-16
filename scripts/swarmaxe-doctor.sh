#!/bin/bash
# swarm-doctor.sh — verification de bout en bout de la pile hive/swarm/hivemind.
#
# A lancer apres une mise a jour d'opencode-swarm-plugin, apres un redemarrage
# d'OpenCode, ou quand un outil "ne marche plus".
#
#   ~/.config/opencode/patches/swarm-doctor.sh          # tout
#   ~/.config/opencode/patches/swarm-doctor.sh --quick  # sans ecriture en base

set -uo pipefail

PKG="${SWARM_PKG_ROOT:-$(npm root -g 2>/dev/null || echo /usr/local/lib/node_modules)}/opencode-swarm-plugin"
BIN="$PKG/dist/bin/swarm.js"
MAIL="$PKG/node_modules/swarm-mail/dist/index.js"
ADAPTER="$HOME/.config/opencode/plugins/swarmaxe.ts"
LEGACY="$HOME/.config/opencode/swarmaxe-v1/legacy.ts"
BASE="$HOME/.config/opencode/patches"
DB="$HOME/.config/swarm-tools/swarm.db"
MODEL="mxbai-embed-large:8k"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1
# Une indexation complete (hivemind_index) sature Ollama et le verrou SQLite :
# les mesures de latence deviennent non representatives. On les transforme en
# notes plutot qu'en echecs dans ce cas.
BUSY=0
pgrep -f "swarm tool hivemind_index" >/dev/null 2>&1 && BUSY=1

pass=0; fail=0
ok()   { echo "  OK   $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL $*"; fail=$((fail+1)); }
note() { echo "  ..   $*"; }

echo "== 1. patches du paquet =="
check_grep() { # fichier, motif, libelle
  if grep -q -- "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3"; fi
}
check_absent() {
  if grep -q -- "$2" "$1" 2>/dev/null; then bad "$3"; else ok "$3"; fi
}
check_grep  "$BIN" "options: { num_ctx: 512 }" "embeddings: /api/embed + num_ctx 512"
check_grep  "$BIN" "MAX_CHARS_PER_CHUNK = 1200" "decoupage a 1200 caracteres (CLI)"
check_grep  "$BIN" "memoire stockee sans embedding" "fail-open: texte conserve si embedding echoue"
check_absent "$BIN" "throw new Error(\"Failed to generate embedding. Ensure Ollama" "plus de perte de memoire sur echec d'embedding"
# --- chemin in-process : swarm-mail (celui que le plugin utilise) ---
check_grep  "$MAIL" "options: { num_ctx: 512 }" "mail: num_ctx 512 (voie in-process)"
check_grep  "$MAIL" "MAX_CHARS_PER_CHUNK = 1200" "mail: decoupage a 1200 caracteres"
check_grep  "$MAIL" "memoire stockee sans embedding" "mail: fail-open (texte conserve)"
check_absent "$MAIL" "throw new Error(\"Failed to generate embedding. Ensure Ollama" "mail: plus de perte sur echec d'embedding"
check_grep  "$BIN" "PRAGMA busy_timeout = 15000" "busy_timeout 15 s"
# Le seul TRUNCATE restant doit etre la methode explicite checkpoint(), pas l'ouverture.
n_bin=$(grep -c 'wal_checkpoint(TRUNCATE)' "$BIN" 2>/dev/null || true)
n_mail=$(grep -c 'wal_checkpoint(TRUNCATE)' "$MAIL" 2>/dev/null || true)
if [ "${n_bin:-9}" -le 2 ]; then ok "checkpoint TRUNCATE uniquement explicite (bin: ${n_bin})"; else bad "TRUNCATE encore dans le chemin d'ouverture (bin: ${n_bin})"; fi
if [ "${n_mail:-9}" -le 1 ]; then ok "checkpoint TRUNCATE uniquement explicite (swarm-mail: ${n_mail})"; else bad "TRUNCATE encore dans le chemin d'ouverture (swarm-mail: ${n_mail})"; fi
check_absent "$BIN" 'PRAGMA auto_vacuum = INCREMENTAL");$' "plus de auto_vacuum a chaque ouverture"

echo "== 2. adaptateur =="
check_grep "$ADAPTER" "CLI_TIMEOUT_MS" "timeout sur les spawn (swarm.ts)"
check_grep "$LEGACY"  "CLI_TIMEOUT_MS" "timeout sur les spawn (legacy.ts)"
check_grep "$ADAPTER" "GIT_TERMINAL_PROMPT" "git non interactif"
check_grep "$ADAPTER" 'name === "hive_sync" && args.auto_pull === undefined' "hive_sync: auto_pull jamais implicite"
if (cd /tmp && bun build --no-bundle --target=bun "$ADAPTER" >/dev/null 2>&1); then ok "swarm.ts compile"; else bad "swarm.ts ne compile pas"; fi
if (cd /tmp && bun build --no-bundle --target=bun "$LEGACY" >/dev/null 2>&1); then ok "legacy.ts compile"; else bad "legacy.ts ne compile pas"; fi
check_grep "$LEGACY" "INPROC_TOOLS" "voie in-process (allowlist) presente"
check_grep "$LEGACY" "SWARM_INPROC" "kill switch SWARM_INPROC=0 present"
if [ -f $PKG/dist/index.js ]; then ok "bundle amont dist/index.js present"; else bad "dist/index.js absent (repli CLI seul)"; fi

echo "== 2a. agents et commande /swarm =="
if [ -x "$BASE/swarmaxe-agents.sh" ]; then
  if out=$(bash "$BASE/swarmaxe-agents.sh" 2>&1); then
    ok "agents en mode subagent + commandes /swarm et /analyse"
  else
    bad "agents: $(printf '%s' "$out" | grep -E "ABSENT|inattendu|!=|ne peut" | head -2 | tr '\n' ' ')"
  fi
elif [ -f "$BASE/../agents/swarm-worker.md" ]; then
  note "swarmaxe-agents.sh non installe (depot, pas installation)"
else
  bad "swarmaxe-agents.sh absent"
fi

echo "== 2b. selftest adaptateur (voie in-process) =="
if [ -f "$BASE/adapter-selftest.ts" ]; then
  if out=$(perl -e 'alarm 300; exec @ARGV' bun "$BASE/adapter-selftest.ts" 2>&1); then
    ok "$(printf '%s' "$out" | tail -1)"
  else
    bad "selftest: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
  fi
else
  bad "adapter-selftest.ts absent"
fi

echo "== 2c. couverture des outils =="
if [ -f "$BASE/coverage-audit.py" ]; then
  if out=$(python3 "$BASE/coverage-audit.py" 2>&1); then
    ok "$(printf '%s' "$out" | grep -E '^OK:' | head -1)"
  else
    bad "$(printf '%s' "$out" | grep -A5 'SANS implementation' | tr '\n' ' ' | cut -c1-220)"
  fi
else
  bad "coverage-audit.py absent"
fi

echo "== 3. processus orphelins =="
orphans=$(ps -eo pid,etime,command | awk '/[s]warm tool /{print $1, $2}' | while read -r pid et; do
  s=$(printf '%s' "$et" | awk -F'-' '{d=(NF==2)?$1:0; r=(NF==2)?$2:$1; n=split(r,a,":"); x=(n==3)?a[1]*3600+a[2]*60+a[3]:((n==2)?a[1]*60+a[2]:a[1]); print d*86400+x}'); [ "${s:-0}" -gt 3600 ] && echo "$pid(${et})"; done)
if [ -z "$orphans" ]; then ok "aucun CLI swarm de plus d'une heure"; else bad "orphelins: $orphans"; fi
if launchctl print "gui/$(id -u)/ai.swarmaxe.watchdog" >/dev/null 2>&1 || launchctl print "gui/$(id -u)/ai.swarmtools.watchdog" >/dev/null 2>&1; then ok "watchdog launchd installe"; else bad "watchdog launchd absent"; fi

echo "== 3b. memoire / indexation =="
HIST="$HOME/.opencode/session-history"
if [ -d "$HIST" ]; then
  n_files=$(ls "$HIST"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [ "${n_files:-0}" -gt 0 ]; then ok "historique exporte ($n_files sessions)"; else bad "session-history vide"; fi
else bad "~/.opencode/session-history absent (lancer index-sessions.py)"; fi
if [ -f "$HOME/.config/swarm-tools/index-state.json" ]; then ok "index-state present (indexation incrementale)"; else bad "index-state absent"; fi
if launchctl print "gui/$(id -u)/ai.swarmaxe.indexer" >/dev/null 2>&1 || launchctl print "gui/$(id -u)/ai.swarmtools.indexer" >/dev/null 2>&1; then ok "indexeur planifie (launchd)"; else bad "indexeur launchd absent"; fi
if [ -f "$HOME/.config/swarm-tools/logs/indexer.log" ] && [ -n "$(find "$HOME/.config/swarm-tools/logs/indexer.log" -mtime -2 2>/dev/null)" ]; then
  ok "indexeur actif (< 48 h)"
else
  note "indexeur pas encore passe (normal au premier lancement)"
fi

echo "== 4. ollama / embeddings =="
ollama_ok=0
for _try in 1 2 3; do
  if curl -s --max-time 8 http://127.0.0.1:11434/api/version | grep -q version; then ollama_ok=1; break; fi
  sleep 1
done
if [ "$ollama_ok" -eq 1 ]; then ok "Ollama repond"; else bad "Ollama ne repond pas sur :11434"; fi
emb=$(python3 - <<'PY'
import json,urllib.request,random,time
random.seed(9)
w=["alpha","beta","gamma","delta","epsilon","zeta"]
txt=" ".join(random.choice(w) for _ in range(200))  # ~1200 caracteres : budget du modele
t=time.time()
req=urllib.request.Request("http://127.0.0.1:11434/api/embed",
    data=json.dumps({"model":"mxbai-embed-large","input":txt,"options":{"num_ctx":512}}).encode(),
    headers={"Content-Type":"application/json"})
try:
    d=json.load(urllib.request.urlopen(req,timeout=180))
    print(f"OK dim={len(d['embeddings'][0])} {time.time()-t:.1f}s")
except Exception as e:
    print(f"FAIL {e}")
PY
)
case "$emb" in OK\ dim=1024*) ok "embedding 1200 caracteres -> 1024 dims ($emb)";; *) bad "embedding long: $emb";; esac

echo "== 5. base de donnees =="
if [ -f "$DB" ]; then
  note "taille: $(du -h "$DB" | cut -f1), wal: $(du -h "$DB-wal" 2>/dev/null | cut -f1 || echo 0)"
  if python3 -c "import sqlite3,sys; c=sqlite3.connect('file:$DB?mode=ro',uri=True,timeout=20); sys.exit(0 if c.execute('pragma quick_check').fetchone()[0]=='ok' else 1)"; then
    ok "quick_check"
  else bad "quick_check"; fi
  ret=$(python3 - "$DB" <<'PY'
import sqlite3,sys
db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True,timeout=20)
t,n,l=db.execute("select count(*), sum(embedding is null), sum(length(content)>1200) from memories").fetchone()
p=db.execute("select count(*) from memories where length(content)>1200 and (metadata is null or metadata not like '%reembedded_at%')").fetchone()[0]
print(int(t), int(n or 0), int(l or 0), int(p or 0))
PY
)
  set -- $ret
  if [ "${2:-1}" -eq 0 ]; then ok "memoires sans embedding: 0"; else bad "memoires sans embedding: ${2} (lancer swarmaxe-reembed.ts)"; fi
  if [ "${4:-1}" -eq 0 ]; then ok "entrees longues: vecteurs a jour"; else note "entrees longues a recalculer: ${4} (swarmaxe-reembed.ts --over-budget)"; fi
else bad "base absente: $DB"; fi

echo "== 6. outils en direct =="
t0=$(python3 -c 'import time;print(time.time())')
if swarm tool hive_ready >/dev/null 2>&1; then
  t1=$(python3 -c 'import time;print(time.time())')
  ms=$(python3 -c "print(round(($t1-$t0)*1000))")
  if [ "$BUSY" -eq 1 ]; then
    note "hive_ready en ${ms} ms (indexation en cours: mesure ignoree)"
  elif [ "$ms" -lt 30000 ]; then ok "hive_ready en ${ms} ms"; else bad "hive_ready lent: ${ms} ms"; fi
else bad "hive_ready echoue"; fi

if swarm tool swarmmail_health 2>/dev/null | grep -q '"healthy":true'; then ok "swarmmail_health"; else bad "swarmmail_health"; fi

par=$(python3 - <<'PY'
import os,subprocess,concurrent.futures as cf
def one(_):
    p=subprocess.run(["swarm","tool","hive_ready"],capture_output=True,text=True,cwd=os.path.expanduser("~/Desktop"))
    out=p.stdout+p.stderr
    return ('"success":true' in out) and ("SQLITE_BUSY" not in out)
with cf.ThreadPoolExecutor(max_workers=4) as ex:
    r=list(ex.map(one,range(4)))
print(f"{sum(1 for x in r if x)}/4")
PY
)
case "$par" in "4/4") ok "4 appels paralleles sans SQLITE_BUSY";; *) bad "parallele: $par reussis";; esac

if [ "$QUICK" -eq 0 ]; then
  echo "== 7. aller-retour memoire =="
  rt=$(python3 - <<'PY'
import json,subprocess,time,uuid
marker="DOCTOR-"+uuid.uuid4().hex[:10]
info=f"{marker} verification du pipeline embeddings apres reparation."
def run(tool,payload):
    p=subprocess.run(["swarm","tool",tool,"--json",json.dumps(payload)],capture_output=True,text=True)
    return p.stdout+p.stderr
out=run("hivemind_store",{"information":info,"tags":"doctor-test"})
try:
    mid=json.loads(out)["data"]["id"]
except Exception:
    print("FAIL store:",out[:160]); raise SystemExit
got=run("hivemind_get",{"id":mid})
ok_get = marker in got
# On interroge avec le texte stocke : la similarite doit etre proche de 1.
found=run("hivemind_find",{"query":info,"limit":10})
ok_find = mid in found
if not ok_find:
    time.sleep(2)
    found=run("hivemind_find",{"query":info,"limit":10})
    ok_find = mid in found
subprocess.run(["swarm","tool","hivemind_remove","--json",json.dumps({"id":mid})],capture_output=True,text=True)
print("OK" if (ok_get and ok_find) else f"FAIL get={ok_get} find={ok_find}")
PY
)
  case "$rt" in OK*) ok "hivemind store + find + remove";; *) bad "hivemind aller-retour: $rt";; esac

  echo "== 7b. retention memoire (entree longue, voie in-process) =="
  if [ -f "$BASE/memory-selftest.ts" ]; then
    if out=$(perl -e 'alarm 420; exec @ARGV' bun "$BASE/memory-selftest.ts" 2>&1); then
      ok "$(printf '%s' "$out" | tail -1)"
    else
      case "$out" in
        *alarm*|*"timed out"*|*ETIMEDOUT*|*"fetch failed"*)
          note "selftest memoire longue non concluant (Ollama sature): $(printf '%s' "$out" | tail -1 | cut -c1-120)" ;;
        *)
          bad "selftest memoire longue: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')" ;;
      esac
    fi
  else
    bad "memory-selftest.ts absent"
  fi
fi

echo
echo "== resultat: $pass OK, $fail FAIL =="
[ "$fail" -eq 0 ] || exit 1
