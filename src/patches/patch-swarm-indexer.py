#!/usr/bin/env python3
"""
patch-swarm-indexer.py — rend `hivemind_index` vraiment incremental.

Probleme : SessionIndexer.indexFile() re-embarque et re-ecrit TOUS les chunks a
chaque appel (aucun memo). Avec 25 fichiers swarm deja indexes + l'historique
OpenCode exporte, chaque `hivemind_index` recoutait plusieurs dizaines de
minutes d'embeddings pour un resultat identique.

Correctif : etat local ~/.config/swarm-tools/index-state.json {path -> {mtimeMs,
chunks}}. Un fichier dont le mtime n'a pas bouge est ignore. Un fichier reecrit
est reindexe (upsert idempotent sur <session_id>-<idx>).

Idempotent : relancer apres chaque mise a jour du paquet.
"""

import shutil
import sys
from pathlib import Path
import os
import subprocess

def resolve_pkg() -> Path:
    env = os.environ.get("SWARM_PKG_ROOT")
    if env:
        return Path(env)
    candidates = []
    try:
        candidates.append(Path(subprocess.check_output(["npm", "root", "-g"], text=True).strip()) / "opencode-swarm-plugin")
    except Exception:
        pass
    candidates += [
        Path.home() / ".bun" / "install" / "global" / "node_modules" / "opencode-swarm-plugin",
        Path("/usr/local/lib/node_modules/opencode-swarm-plugin"),
        Path("/opt/homebrew/lib/node_modules/opencode-swarm-plugin"),
        Path("/usr/lib/node_modules/opencode-swarm-plugin"),
    ]
    for c in candidates:
        if (c / "dist" / "index.js").exists():
            return c
    return candidates[0] if candidates else Path("/nonexistent/opencode-swarm-plugin")


PKG = resolve_pkg()
SAMPLE_PROJECT = os.environ.get("SWARMAXE_PROJECT", str(Path.home() / "Desktop"))

PKG = resolve_pkg()
BIN = PKG / "dist" / "bin" / "swarm.js"

IMPORT_ANCHOR = 'import { promises as fs2 } from "node:fs";\n'
IMPORT_ADD = (
    IMPORT_ANCHOR
    + 'import { statSync as __swarmStatSync, readFileSync as __swarmReadStateFile, writeFileSync as __swarmWriteStateFile } from "node:fs";\n'
)

HELPERS_ANCHOR = "class SessionIndexer {\n"
HELPERS = """var __swarmIndexState = null;
var __swarmIndexStatePath = `${process.env.HOME || ""}/.config/swarm-tools/index-state.json`;
function __swarmReadIndexState() {
  if (__swarmIndexState) return __swarmIndexState;
  try {
    __swarmIndexState = JSON.parse(__swarmReadStateFile(__swarmIndexStatePath, "utf-8"));
    if (!__swarmIndexState || typeof __swarmIndexState !== "object") __swarmIndexState = {};
  } catch {
    __swarmIndexState = {};
  }
  return __swarmIndexState;
}
function __swarmSaveIndexState(state) {
  try {
    __swarmWriteStateFile(__swarmIndexStatePath, JSON.stringify(state));
  } catch {}
}

class SessionIndexer {
"""

SKIP_ANCHORS = [
    ("      let skipped = 0;\n      const content = yield* _(exports_Effect.tryPromise({"),
    ("      let skipped = 0;\n      const content = yield* _(exports_Effect3.tryPromise({"),
]
SKIP_INSERT = """      let skipped = 0;
      try {
        const __st = __swarmStatSync(filePath);
        const __done = __swarmReadIndexState()[filePath];
        if (__done && __done.chunks > 0 && __done.mtimeMs >= __st.mtimeMs) {
          return {
            path: filePath,
            agent_type: "opencode-swarm",
            indexed: 0,
            skipped: 1,
            duration_ms: Date.now() - startTime,
            cached: true
          };
        }
      } catch {}
"""
SKIP_TAIL = "      const content = yield* _(exports_Effect"

SAVE_ANCHOR = """      self2.indexedFiles.set(filePath, {
        timestamp: new Date,
        chunks: indexed
      });
"""
SAVE_INSERT = SAVE_ANCHOR + """      try {
        if (indexed > 0) {
          const __state2 = __swarmReadIndexState();
          __state2[filePath] = { mtimeMs: __swarmStatSync(filePath).mtimeMs, chunks: indexed };
          __swarmSaveIndexState(__state2);
        }
      } catch {}
"""


def main() -> int:
    if not BIN.exists():
        print(f"!! {BIN} introuvable")
        return 1
    text = BIN.read_text(encoding="utf-8", errors="surrogateescape")
    before = text

    if "__swarmReadIndexState" in text:
        print("== deja a jour")
    else:
        if IMPORT_ANCHOR not in text:
            print("!! ancre import introuvable")
            return 2
        text = text.replace(IMPORT_ANCHOR, IMPORT_ADD, 1)

        if HELPERS_ANCHOR not in text:
            print("!! ancre classe introuvable")
            return 2
        text = text.replace(HELPERS_ANCHOR, HELPERS, 1)

        for anchor in SKIP_ANCHORS:
            eff = "exports_Effect3" if "Effect3" in anchor else "exports_Effect"
            new = SKIP_INSERT + f"      const content = yield* _({eff}.tryPromise({{"
            if anchor not in text:
                print(f"!! ancre skip introuvable: {anchor[:60]}")
                return 2
            text = text.replace(anchor, new, 1)

        n_save = text.count(SAVE_ANCHOR)
        if n_save == 0:
            print("!! ancre save introuvable")
            return 2
        text = text.replace(SAVE_ANCHOR, SAVE_INSERT)

        backup = BIN.with_suffix(BIN.suffix + ".pre-indexpatch")
        if not backup.exists():
            shutil.copy2(BIN, backup)
        BIN.write_text(text, encoding="utf-8", errors="surrogateescape")
        print(f"++ patche {BIN.name}: skip={len(SKIP_ANCHORS)} save={n_save}")

    checks = {
        "import sync fs": "__swarmStatSync" in text,
        "helpers": "__swarmReadIndexState" in text,
        "skip mtime (x2)": text.count("__done.mtimeMs >= __st.mtimeMs") == 2,
        "save state (x2)": text.count("__state2[filePath] = { mtimeMs") == 2,
    }
    ok = True
    print("\n-- verification --")
    for name, val in checks.items():
        print(f"   {'OK  ' if val else 'FAIL'} {name}")
        ok = ok and val
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())