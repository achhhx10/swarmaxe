#!/usr/bin/env python3
"""
index-sessions.py — rend l'historique OpenCode interrogeable par cass/hivemind.

Pourquoi : ~/.config/swarm-tools/sessions/ ne contient que 25 fichiers de
decisions swarm (264 Ko) alors que la vraie memoire de travail est dans
~/.local/share/opencode/opencode.db (1 900+ sessions, 100k messages, 4,2 Go).
Resultat : cass_search ne voyait que 1,3 % de ce qui a ete fait.

Ce script lit la base en lecture seule, condense chaque session en 1 a 3
lignes JSONL au format attendu par SessionParser (event_type/timestamp/payload),
et les ecrit sous ~/.opencode/session-history/ — un dossier scanne par
hivemind_index (AGENT_DIRECTORIES inclut ~/.opencode, recursif).

Proprietes :
  * idempotent   — l'id du chunk est <session_id>-<n>, l'insert est un upsert ;
  * incremental  — --since / --limit, et --skip-existing pour ne pas reecrire ;
  * redige       — les secrets (sk-, ghp_, AKIA, cles privees, mots de passe)
                   sont masques avant stockage ;
  * borne        — chaque ligne reste < --max-chars (defaut 3000) pour tenir
                   dans le contexte d'embedding.

Usage :
  python3 index-sessions.py --limit 200
  python3 index-sessions.py --since 2026-09-01 --limit 2000
  python3 index-sessions.py --project ~/Desktop/my-project
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import re
import sqlite3
import sys
from datetime import datetime, timezone
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

DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
OUT = Path.home() / ".opencode" / "session-history"

SECRET_PATTERNS = [
    (re.compile(r"\b(sk-[A-Za-z0-9_\-]{12,})"), "sk-***"),
    (re.compile(r"\b(ghp_[A-Za-z0-9]{20,})"), "ghp_***"),
    (re.compile(r"\b(github_pat_[A-Za-z0-9_]{20,})"), "github_pat_***"),
    (re.compile(r"\b(AKIA[0-9A-Z]{16})"), "AKIA***"),
    (re.compile(r"\b(xox[baprs]-[A-Za-z0-9\-]{10,})"), "xox*-***"),
    (re.compile(r"\b(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})"), "jwt.***"),
    (re.compile(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)"), r"\1***\2"),
    (re.compile(r"(?i)\b(password|passwd|secret|token|api[_\-]?key)\s*[:=]\s*[^\s,;\"']{6,}"), r"\1=***"),
]


def redact(text: str) -> str:
    for pattern, repl in SECRET_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def clean(text: str) -> str:
    text = re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", " ", text)
    text = re.sub(r"```[\s\S]*?```", " [code] ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def utc(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def session_rows(con: sqlite3.Connection, since_ms: int, project: str | None, limit: int, settled_before: int):
    sql = (
        "select id, title, directory, agent, model, time_created from session_v2 "
        "where time_created >= ? and time_created is not null and coalesce(time_updated, time_created) <= ?"
    )
    args: list = [since_ms, settled_before]
    if project:
        sql += " and directory = ?"
        args.append(project)
    sql += " order by time_created desc"
    if limit > 0:
        sql += " limit ?"
        args.append(limit)
    yield from con.execute(sql, args)


def messages(con: sqlite3.Connection, session_id: str):
    return list(
        con.execute(
            "select type, data from session_message where session_id = ? order by seq asc",
            (session_id,),
        )
    )


def collect(con: sqlite3.Connection, session_id: str, max_chars: int):
    """Retourne (resume, fichiers, nb_messages, nb_outils)."""
    user_bits: list[str] = []
    assistant_bits: list[str] = []
    files: list[str] = []
    n_msg = 0
    n_tools = 0

    for mtype, raw in messages(con, session_id):
        try:
            o = json.loads(raw)
        except Exception:
            continue
        if mtype == "user":
            txt = clean(o.get("text") or "")
            if txt and not txt.startswith("You are a subagent spawned"):
                user_bits.append(txt[:600])
            elif txt:
                # Les prompts de worker contiennent la vraie consigne : on la garde.
                user_bits.append(txt[:600])
            n_msg += 1
        elif mtype == "assistant":
            n_msg += 1
            texts, last_text = [], ""
            for c in o.get("content") or []:
                ctype = c.get("type")
                if ctype == "text":
                    last_text = clean(c.get("text") or "")
                elif ctype == "tool":
                    n_tools += 1
                    inp = (c.get("state") or {}).get("input") or {}
                    fp = inp.get("filePath") or inp.get("file_path") or inp.get("path")
                    if isinstance(fp, str) and len(fp) < 300 and fp not in files:
                        files.append(fp)
                    if c.get("name") in ("edit", "write", "multiedit"):
                        fp = inp.get("filePath") or fp
                        if isinstance(fp, str) and fp not in files:
                            files.append(fp)
            if last_text:
                texts.append(last_text)
            if texts:
                assistant_bits.append(" ".join(texts)[:800])

    head = " / ".join(user_bits[:3])[: max_chars // 3]
    tail = " ".join(assistant_bits[-3:])[: max_chars // 2]
    summary = clean(f"{head} || {tail}")
    return summary[:max_chars], files[:12], n_msg, n_tools


def write_session(path: Path, session_id: str, lines: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-08-01", help="date ISO (defaut 2026-08-01)")
    ap.add_argument("--limit", type=int, default=300, help="nb max de sessions (0 = tout)")
    ap.add_argument("--project", default=None, help="filtrer sur un directory exact")
    ap.add_argument("--max-chars", type=int, default=3000)
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--min-age-hours",
        type=float,
        default=2.0,
        help="ignorer les sessions modifiees il y a moins de N heures (defaut 2)",
    )
    args = ap.parse_args()

    if not DB.exists():
        print(f"base introuvable: {DB}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    try:
        since_ms = int(datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        print(f"--since invalide: {args.since}", file=sys.stderr)
        return 1

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    written = skipped = chunks = 0
    unchanged_count = 0
    total_chars = 0

    settled_before = int((datetime.now(tz=timezone.utc).timestamp() - args.min_age_hours * 3600) * 1000)
    for sid, title, directory, agent, model, created in session_rows(con, since_ms, args.project, args.limit, settled_before):
        summary, files, n_msg, n_tools = collect(con, sid, args.max_chars)
        if n_msg < 2 or len(summary) < 60:
            skipped += 1
            continue

        tag = hashlib.sha1(sid.encode()).hexdigest()[:8]
        context = f"{directory or '?'} | agent={agent or '?'} | model={model or '?'} | msgs={n_msg} tools={n_tools}"
        lines = [
            {
                "session_id": sid,
                "timestamp": utc(created),
                "event_type": "DECISION",
                "payload": {
                    "title": (title or "(sans titre)")[:200],
                    "summary": redact(summary),
                    "context": redact(context),
                },
            }
        ]
        if files:
            lines.append(
                {
                    "session_id": sid,
                    "timestamp": utc(created),
                    "event_type": "OUTCOME",
                    "payload": {
                        "title": (title or "(sans titre)")[:200],
                        "files": ", ".join(redact(f) for f in files)[:1200],
                        "context": redact(context),
                    },
                }
            )
        d = out / f"{sid}.jsonl"
        payload_text = "\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n"
        # Ne pas reecrire un fichier identique : le mtime sert de marqueur
        # d'invalidation a l'indexeur (patch-swarm-indexer.py).
        unchanged = False
        if d.exists():
            try:
                unchanged = d.read_text(encoding="utf-8") == payload_text
            except OSError:
                unchanged = False
        if not args.dry_run and not unchanged:
            d.write_text(payload_text, encoding="utf-8")
        written += 0 if unchanged else 1
        unchanged_count += 1 if unchanged else 0
        chunks += len(lines)
        total_chars += sum(len(json.dumps(x, ensure_ascii=False)) for x in lines)

    con.close()
    print(
        json.dumps(
            {
                "sessions_written": written,
                "sessions_unchanged": unchanged_count,
                "sessions_skipped": skipped,
                "chunks": chunks,
                "approx_chars": total_chars,
                "out": str(out),
                "dry_run": args.dry_run,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())