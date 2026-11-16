#!/usr/bin/env python3
"""
coverage-audit.py — verifie que chaque outil expose par l'adaptateur a bien
une implementation derriere lui (registre amont ou CLI), pour attraper les
noms morts, les fautes de frappe et les outils declares mais jamais servis.

Trois sources cote adaptateur :
  1. le registre du wrapper V1 (~/.config/opencode/swarm-v1/legacy.ts)
  2. EXTRA_TOOL_NAMES (~/.config/opencode/plugins/swarm.ts)
  3. les outils pousses manuellement (name: "...") dans swarm.ts

Deux sources cote implementation :
  A. le registre amont (dist/index.js -> SwarmPlugin().tool)
  B. `swarm tool --list`

Sortie : une ligne par outil sans implementation, puis un resume.
Code retour 1 si au moins un outil est orphelin.
"""

from __future__ import annotations

import json
import shutil
import re
import subprocess
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

HOME = Path.home()
LEGACY = Path(os.environ.get("SWARMAXE_LEGACY", HOME / ".config/opencode/swarmaxe-v1/legacy.ts"))
ADAPTER = Path(os.environ.get("SWARMAXE_ADAPTER", HOME / ".config/opencode/plugins/swarmaxe.ts"))
ENTRY = PKG / "dist" / "index.js"

NAME_RE = re.compile(r"^[a-z][a-z0-9_\-]+$")


def names_from_legacy(text: str) -> set[str]:
    i = text.find("return {\n    tool: {")
    if i < 0:
        return set()
    j = text.find("\n    },", i)
    block = text[i:j]
    out: set[str] = set()
    for line in block.splitlines():
        line = line.strip()
        m = re.match(r"^([a-z][a-z0-9_\-]*),$", line)
        if m and NAME_RE.match(m.group(1)):
            out.add(m.group(1))
    return out


def names_from_adapter(text: str) -> set[str]:
    out: set[str] = set()
    m = re.search(r"const EXTRA_TOOL_NAMES = \[(.*?)\]", text, re.S)
    if m:
        out |= set(re.findall(r'"([a-z][a-z0-9_\-]+)"', m.group(1)))
    # outils pousses manuellement : tools.push({ ... name: "..." })
    for m2 in re.finditer(r'tools\.push\(\{\s*\n\s*name:\s*"([a-z][a-z0-9_\-]+)"', text):
        out.add(m2.group(1))
    return out


def local_implementations(text: str) -> set[str]:
    """Outils pousses dans setup() et implementes sur place (pas via le CLI)."""
    out: set[str] = set()
    for chunk in text.split("tools.push({")[1:]:
        nm = re.search(r'name:\s*"([a-z][a-z0-9_\-]+)"', chunk[:3000])
        if not nm:
            continue
        if "runSwarmCli(" not in chunk[:12000]:
            out.add(nm.group(1))
    return out


def alias_targets(text: str) -> set[str]:
    """Outils servis par un alias CLI (CLI_ALIASES) ou nativement."""
    out: set[str] = set()
    m = re.search(r"const CLI_ALIASES[^=]*=\s*\{(.*?)\n\}", text, re.S)
    if m:
        for name, target in re.findall(r'^\s*([a-z][a-z0-9_\-]*):\s*\{\s*cli:\s*"([a-z][a-z0-9_\-]+)"', m.group(1), re.M):
            out.add(name)
            out.add(target)
    k = text.find("const INSIGHT_QUERIES")
    if k >= 0:
        brace = text.find("{", k)
        end = text.find("\n}", brace)
        if brace >= 0 and end > brace:
            out |= set(re.findall(r'^\s*([a-z][a-z0-9_\-]*):', text[brace:end], re.M))
    return out


def upstream_names() -> set[str]:
    js = """
const mod = await import(process.env.__ENTRY);
const f = mod.SwarmPlugin ?? mod.default;
const p = await f({directory:process.env.__PROJECT, client:{}, project:{}});
console.log(JSON.stringify(Object.keys(p.tool||{})));
"""
    env = {"__ENTRY": str(ENTRY), "__PROJECT": str(Path.home() / "Desktop"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"}
    try:
        r = subprocess.run(
            [shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun"), "-e", js],
            capture_output=True, text=True, timeout=120, cwd=str(Path.home() / "Desktop"), env=env,
        )
        if r.returncode != 0:
            print(f"!! registre amont illisible: {r.stderr[:200]}", file=sys.stderr)
            return set()
        return set(json.loads(r.stdout.strip().splitlines()[-1]))
    except Exception as e:
        print(f"!! registre amont: {e}", file=sys.stderr)
        return set()


def cli_names() -> set[str]:
    try:
        r = subprocess.run(
            ["swarm", "tool", "--list"],
            capture_output=True, text=True, timeout=120, cwd=str(Path.home() / "Desktop"),
        )
        out = r.stdout + r.stderr
        return {m for m in re.findall(r"^\s{2,}([a-z][a-z0-9_\-]+)$", out, re.M)}
    except Exception as e:
        print(f"!! CLI: {e}", file=sys.stderr)
        return set()


def main() -> int:
    adapter_text = ADAPTER.read_text()
    legacy = names_from_legacy(LEGACY.read_text())
    adapter = names_from_adapter(adapter_text)
    aliased = alias_targets(adapter_text)
    local = local_implementations(adapter_text)
    declared = (legacy | adapter) - {"swarm-worker"}
    up = upstream_names()
    cli = cli_names()
    impl = up | cli

    print(f"outils declares par l'adaptateur : {len(declared)} "
          f"(wrapper {len(legacy)}, extras/manuels {len(adapter - legacy)})")
    print(f"implementations disponibles    : {len(impl)} (amont {len(up)}, cli {len(cli)})")

    orphans = sorted(n for n in declared if n not in impl and n not in aliased and n not in local)
    unused = sorted(n for n in impl if n not in declared)
    print(f"outils amont non exposes       : {len(unused)}")
    print(f"implementations locales        : {len(local)}")
    if orphans:
        print("\n!! outils SANS implementation :")
        for n in orphans:
            print("   -", n)
    else:
        print("\nOK: chaque outil expose a une implementation.")
    return 1 if orphans else 0


if __name__ == "__main__":
    sys.exit(main())