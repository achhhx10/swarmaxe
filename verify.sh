#!/bin/bash
# verify.sh — verifie le depot sans l'installer (CI-friendly, sans reseau).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/swarmaxe-pyc"
fail=0
ok() { echo "  OK   $*"; }
bad() { echo "  FAIL $*"; fail=$((fail + 1)); }

echo "== couverture des outils (adapter du depot) =="
if SWARMAXE_ADAPTER="$HERE/src/adapter/swarmaxe.ts" \
   SWARMAXE_LEGACY="$HERE/src/adapter/legacy.ts" \
   python3 "$HERE/scripts/coverage-audit.py" >/tmp/swarmaxe-coverage.txt 2>&1; then
  ok "$(grep -E '^OK:' /tmp/swarmaxe-coverage.txt | head -1)"
else
  bad "$(tail -5 /tmp/swarmaxe-coverage.txt | tr '\n' ' ')"
fi

echo "== skill forge =="
if bun "$HERE/tests/forge-test.ts" >/tmp/swarmaxe-forge.txt 2>&1; then
  ok "$(tail -1 /tmp/swarmaxe-forge.txt)"
else
  bad "$(tail -3 /tmp/swarmaxe-forge.txt | tr '\n' ' ')"
fi

echo "== memoire (decoupage + fusion) =="
if bun "$HERE/tests/memory-test.ts" >/tmp/swarmaxe-memory.txt 2>&1; then
  ok "$(tail -1 /tmp/swarmaxe-memory.txt)"
else
  bad "$(tail -3 /tmp/swarmaxe-memory.txt | tr '\n' ' ')"
fi

echo "== compilation =="
for f in src/adapter/swarmaxe.ts src/adapter/legacy.ts src/lib/skill-forge.ts src/lib/memory.ts scripts/adapter-selftest.ts scripts/memory-selftest.ts tests/memory-test.ts; do
  if bun build --no-bundle --target=node "$f" >/tmp/swarmaxe-verify.js 2>/dev/null && node --check /tmp/swarmaxe-verify.js 2>/dev/null; then
    ok "node --check $f"
  else
    bad "node --check $f"
  fi
done
for f in src/patches/*.py scripts/*.py; do
  python3 -m py_compile "$f" 2>/dev/null && ok "py_compile $f" || bad "py_compile $f"
done
for f in install.sh uninstall.sh scripts/*.sh; do
  bash -n "$f" 2>/dev/null && ok "bash -n $f" || bad "bash -n $f"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "VERIFY OK"
else
  echo "VERIFY FAIL ($fail)"
fi
exit "$([ "$fail" -eq 0 ] && echo 0 || echo 1)"
