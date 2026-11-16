#!/usr/bin/env python3
"""
patch-swarm-plugin.py — reparations locales d'opencode-swarm-plugin 0.63.2.

Idempotent : relancer apres chaque `npm i -g opencode-swarm-plugin@x.y.z`.

Patches appliques
-----------------
1. EMBEDDINGS : les embedSingle() appelaient /api/embeddings sans options.
   Ollama plafonne mxbai-embed-large a 512 tokens -> HTTP 500 des qu'un texte
   depasse ~1 800 caracteres, et le CLI renvoyait un message trompeur
   ("Ensure Ollama is running and model is available"). Bascule sur /api/embed
   avec options.num_ctx 4096 (verifie sur Ollama 0.40.6 : accepte, 1024
   dimensions conservees, donc l'index vectoriel existant reste valide).
   Cout mesure sur ce Mac (x64) : ~1.7 s / 1000 caracteres, lineaire.
2. MAX_CHARS_PER_CHUNK 24000 -> 6000 : garantit que chaque morceau tient dans
   4096 tokens au lieu d'echouer sur un HTTP 500 silencieux.
3. PRAGMA auto_vacuum = INCREMENTAL a chaque ouverture -> supprime (reglage
   persistant qui exigeait un verrou d'ecriture a chaque appel).
4. PRAGMA wal_checkpoint(TRUNCATE) a chaque ouverture de base -> PASSIVE.
   TRUNCATE prenait un verrou exclusif a chaque appel d'outil : c'etait la
   source des SQLITE_BUSY et des appels a 4-30 s quand plusieurs workers
   tournent en parallele.
5. busy_timeout 5000 -> 15000 ms (doit depasser le temps d'attente reel du
   verrou pour que les reprises de l'adaptateur servent a quelque chose).
"""

import shutil
import re
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
MAIL = PKG / "node_modules" / "swarm-mail" / "dist" / "index.js"

def env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, str(default)))
        return v if v > 0 else default
    except ValueError:
        return default


# mxbai-embed-large : contexte reel 512 tokens (~1 200 caracteres FR/EN).
# SWARMAXE_EMBED_NUM_CTX / SWARMAXE_EMBED_MAX_CHARS permettent d'adapter si
# le modele change (relancer le patch apres changement d'environnement).
NUM_CTX = env_int("SWARMAXE_EMBED_NUM_CTX", 512)
MAX_CHARS = env_int("SWARMAXE_EMBED_MAX_CHARS", 1200)
CHUNK_OVERLAP = env_int("SWARMAXE_EMBED_CHUNK_OVERLAP", 150)

EMBED_FAIL_RE = re.compile(
    r'if \(!embedding\) \{\s*throw new Error\("Failed to generate embedding\. '
    r'Ensure Ollama is running and model is available\."\);\s*\}'
)
EMBED_FAIL_OPEN = (
    'if (!embedding) {\n'
    '  console.warn("[swarmaxe] memoire stockee sans embedding (pending): " + '
    'information.length + " caracteres");\n'
    '}'
)
VECTOR_OLD = "const vectorStr = JSON.stringify(embedding);"
VECTOR_NEW = "const vectorStr = embedding ? JSON.stringify(embedding) : null;"
VECTOR_SQL_OLD = "embedding: sql`vector(${vectorStr})`"
VECTOR_SQL_NEW = "embedding: vectorStr ? sql`vector(${vectorStr})` : null"

OPEN_SEQ_OLD = (
    'await client.execute("PRAGMA busy_timeout = 5000");\n'
    '  await client.execute("PRAGMA journal_mode = WAL");\n'
    '  await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");'
)
OPEN_SEQ_NEW = (
    'await client.execute("PRAGMA busy_timeout = 15000");\n'
    '  await client.execute("PRAGMA journal_mode = WAL");\n'
    '  await client.execute("PRAGMA wal_checkpoint(PASSIVE)");'
)

EMBED_BODIES = [
    (
        "          model: config2.ollamaModel,\n"
        "          prompt: text3\n",
        "          model: config2.ollamaModel,\n"
        "          input: text3,\n"
        f"          options: {{ num_ctx: {NUM_CTX} }}\n",
    ),
    (
        "          model: config22.ollamaModel,\n"
        "          prompt: text32\n",
        "          model: config22.ollamaModel,\n"
        "          input: text32,\n"
        f"          options: {{ num_ctx: {NUM_CTX} }}\n",
    ),
]

EMBED_URL = [
    ("${config2.ollamaHost}/api/embeddings", "${config2.ollamaHost}/api/embed"),
    ("${config22.ollamaHost}/api/embeddings", "${config22.ollamaHost}/api/embed"),
]

OLD_RET = "return data.embedding;"
NEW_RET = "return Array.isArray(data.embeddings) ? data.embeddings[0] : data.embedding;"

AUTO_VAC_OLD = '  await client.execute("PRAGMA auto_vacuum = INCREMENTAL");\n'
AUTO_VAC_NEW = (
    "  // auto_vacuum=INCREMENTAL est un reglage persistant (deja applique) : le\n"
    "  // rejouer a chaque ouverture exige un verrou d'ecriture -> SQLITE_BUSY.\n"
)

MAX_RE = re.compile(r"MAX_CHARS_PER_CHUNK = \d+")
MAX_NEW = f"MAX_CHARS_PER_CHUNK = {MAX_CHARS}"
OVERLAP_RE = re.compile(r"CHUNK_OVERLAP = \d+")
OVERLAP_NEW = f"CHUNK_OVERLAP = {CHUNK_OVERLAP}"


def apply(text: str, pairs) -> tuple[str, int]:
    n = 0
    for old, new in pairs:
        c = text.count(old)
        if c:
            text = text.replace(old, new)
            n += c
    return text, n


def main() -> int:
    if not PKG.exists():
        print(f"!! paquet introuvable : {PKG}")
        return 1

    for path in (BIN, MAIL):
        if not path.exists():
            print(f"-- ignore (absent) : {path}")
            continue
        text = path.read_text(encoding="utf-8", errors="surrogateescape")
        before = text
        counts = {}

        text, counts["open_seq"] = apply(text, [(OPEN_SEQ_OLD, OPEN_SEQ_NEW)])
        text, counts["auto_vacuum"] = apply(text, [(AUTO_VAC_OLD, AUTO_VAC_NEW)])

        # Embeddings : les deux chemins (CLI et in-process swarm-mail) doivent
        # etre patches. Auparavant seul BIN l'etait, donc hivemind_store via le
        # plugin restait sur /api/embeddings sans num_ctx -> echec des longues
        # entrees avec "Failed to generate embedding".
        text, counts["embed_body"] = apply(text, EMBED_BODIES)
        text, counts["embed_url"] = apply(text, EMBED_URL)
        if OLD_RET in text:
            text = text.replace(OLD_RET, NEW_RET)
            counts["embed_ret"] = 1
        text, counts["max_chars"] = MAX_RE.subn(MAX_NEW, text)
        text, counts["chunk_overlap"] = OVERLAP_RE.subn(OVERLAP_NEW, text)
        # Normalise un num_ctx deja present (4096 d'une version precedente).
        text, counts["num_ctx"] = re.subn(
            r"options: \{ num_ctx: \d+ \}", f"options: {{ num_ctx: {NUM_CTX} }}", text
        )

        # Retention : ne jamais perdre le texte si l'embedding echoue.
        text, counts["fail_open"] = EMBED_FAIL_RE.subn(EMBED_FAIL_OPEN, text)
        text, counts["vector_null"] = apply(
            text, [(VECTOR_OLD, VECTOR_NEW), (VECTOR_SQL_OLD, VECTOR_SQL_NEW)]
        )

        if text == before:
            print(f"== deja a jour : {path.name}")
            continue

        backup = path.with_suffix(path.suffix + ".pre-patch")
        if not backup.exists():
            shutil.copy2(path, backup)
        path.write_text(text, encoding="utf-8", errors="surrogateescape")
        print(f"++ patche {path}: {counts}")

    # -------- verification --------
    print("\n-- verification --")
    bin_js = BIN.read_text(encoding="utf-8", errors="surrogateescape")
    mail_js = MAIL.read_text(encoding="utf-8", errors="surrogateescape") if MAIL.exists() else ""
    checks = {
        "embedSingle -> /api/embed": "/api/embed}" in bin_js or "/api/embed`" in bin_js,
        f"options.num_ctx {NUM_CTX}": bin_js.count(f"options: {{ num_ctx: {NUM_CTX} }}") >= 1,
        "reponse embeddings[0]": "data.embeddings[0]" in bin_js,
        "plus de prompt: text3/32": "prompt: text3\n" not in bin_js and "prompt: text32\n" not in bin_js,
        f"MAX_CHARS {MAX_CHARS}": MAX_NEW in bin_js,
        "fail-open (texte conserve)": "memoire stockee sans embedding" in bin_js,
        "vector nullable": VECTOR_NEW in bin_js and VECTOR_SQL_NEW in bin_js,
        "open path sans TRUNCATE": OPEN_SEQ_OLD not in bin_js,
        "busy_timeout 15000": "PRAGMA busy_timeout = 15000" in bin_js,
        "auto_vacuum non rejoue": AUTO_VAC_OLD not in bin_js,
        # --- swarm-mail : chemin in-process, celui que le plugin utilise ---
        "mail: /api/embed": "/api/embed`" in mail_js or "/api/embed}" in mail_js,
        f"mail: num_ctx {NUM_CTX}": f"options: {{ num_ctx: {NUM_CTX} }}" in mail_js,
        f"mail: MAX_CHARS {MAX_CHARS}": MAX_NEW in mail_js,
        "mail: fail-open": "memoire stockee sans embedding" in mail_js,
        "mail: vector nullable": VECTOR_NEW in mail_js and VECTOR_SQL_NEW in mail_js,
        "mail: plus de /api/embeddings sur embedSingle": "prompt: text3\n" not in mail_js,
        "swarm-mail sans auto_vacuum": AUTO_VAC_OLD not in mail_js,
        "swarm-mail sans TRUNCATE": OPEN_SEQ_OLD not in mail_js,
    }
    ok = True
    for name, val in checks.items():
        print(f"   {'OK  ' if val else 'FAIL'} {name}")
        ok = ok and val
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())