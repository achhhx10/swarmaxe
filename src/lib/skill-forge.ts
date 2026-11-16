/**
 * skill-forge.ts — coeur de la gouvernance des skills (Swarmaxe Skill Forge).
 *
 * Module pur, sans dependance au plugin, pour pouvoir etre teste seul :
 *   - validateSkill : refuse les skills vagues, dupliques ou dangereux
 *   - renderSkill   : produit un SKILL.md au format OpenCode
 *   - syntaxCheck   : bash -n / py_compile sur les scripts fournis
 *   - skillRoot     : emplacement global ou projet
 *
 * Contrat du frontmatter (OpenCode) : `name` + `description` courts, puis un
 * corps qui porte les sections imposees. Un skill sans "When NOT to use" ni
 * verification executable n'est pas publiable : c'est ce qui evite la
 * proliferation de skills fourre-tout.
 *
 * ATTENTION : pas de regex a flags inline `(?i)` (syntaxe Python, invalide en
 * JS). Utiliser /.../i. `bun build` ne detecte pas ces erreurs ; `node --check`
 * oui.
 */

import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

export const SKILL_SECTIONS = ["## When to use", "## When NOT to use", "## Steps", "## Verification"]

export const SKILL_SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
]

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_SCRIPT_RE = /^[a-z0-9][a-z0-9._-]*\.(sh|py)$/

export function skillRoot(scope: string, dir: string): string {
  return scope === "project"
    ? join(dir, ".opencode", "skills")
    : join(homedir(), ".config", "opencode", "skills")
}

export function renderSkill(a: any): string {
  const esc = (v: string) => String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const list = (xs: any, bullet: string) =>
    (Array.isArray(xs) ? xs.filter((x: any) => String(x ?? "").trim()) : [])
      .map((x: any) => `${bullet} ${String(x).trim()}`)
      .join("\n")
  const steps = (Array.isArray(a.steps) ? a.steps : [])
    .filter((x: any) => String(x ?? "").trim())
    .map((x: any, i: number) => `${i + 1}. ${String(x).trim()}`)
    .join("\n")
  const parts = [
    "---",
    `name: ${a.name}`,
    `description: "${esc(a.description)}"`,
    "---",
    "",
    `# ${a.name}`,
    "",
    "## When to use",
    String(a.when_to_use ?? "").trim(),
    "",
    "## When NOT to use",
    String(a.when_not_to_use ?? "").trim(),
    "",
    "## Steps",
    steps,
    "",
    "## Verification",
    list(a.verification, "-"),
  ]
  if (list(a.pitfalls, "-")) parts.push("", "## Pitfalls", list(a.pitfalls, "-"))
  if (list(a.references, "-")) parts.push("", "## References", list(a.references, "-"))
  return parts.join("\n") + "\n"
}

export function validateSkill(a: any, root: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  const name = String(a.name ?? "")
  if (!SKILL_NAME_RE.test(name) || name.length < 3 || name.length > 64) {
    errors.push("name: kebab-case attendu (a-z0-9 + tirets, 3-64 caracteres)")
  }

  const desc = String(a.description ?? "")
  if (desc.length < 20 || desc.length > 200 || desc.includes("\n")) {
    errors.push("description: 20-200 caracteres, une seule ligne")
  }

  if (!String(a.when_to_use ?? "").trim()) errors.push("when_to_use: requis")
  if (!String(a.when_not_to_use ?? "").trim()) {
    errors.push("when_not_to_use: requis (c'est ce qui evite les skills fourre-tout)")
  }

  const steps = Array.isArray(a.steps) ? a.steps.filter((x: any) => String(x ?? "").trim()) : []
  if (steps.length < 2) errors.push("steps: au moins 2 etapes")
  for (const [i, st] of steps.entries()) {
    if (String(st).length > 600) warnings.push(`steps[${i}]: tres long (>600 caracteres)`)
  }

  const verif = Array.isArray(a.verification) ? a.verification.filter((x: any) => String(x ?? "").trim()) : []
  if (verif.length < 1) errors.push("verification: au moins un controle executable")

  const body = renderSkill(a)
  if (body.length > 20000) errors.push("corps du skill > 20 000 caracteres")

  const blob = body + JSON.stringify(a.scripts ?? [])
  for (const re of SKILL_SECRET_PATTERNS) {
    if (re.test(blob)) {
      errors.push(`secret detecte (${re.source.slice(0, 24)}...) : retire-le avant publication`)
    }
  }

  if (name && existsSync(join(root, name)) && !a.overwrite) {
    errors.push(`le skill '${name}' existe deja (overwrite:true pour remplacer)`)
  }

  const scripts = Array.isArray(a.scripts) ? a.scripts : []
  for (const s of scripts) {
    const fn = String(s?.filename ?? "")
    if (!SKILL_SCRIPT_RE.test(fn)) errors.push(`script '${fn}': nom de fichier attendu (a-z0-9._- + .sh/.py)`)
    if (typeof s?.content !== "string" || s.content.length > 100000) {
      errors.push(`script '${fn}': contenu manquant ou > 100 Ko`)
    }
  }

  return { errors, warnings }
}

/** Verifie la syntaxe des scripts (bash -n / py_compile) dans `root`. */
export function syntaxCheck(root: string, scripts: any[]): string[] {
  const bad: string[] = []
  for (const s of scripts) {
    const fn = String(s.filename)
    const path = join(root, fn)
    const cmd = fn.endsWith(".sh")
      ? ["bash", "-n", path]
      : fn.endsWith(".py")
        ? ["python3", "-m", "py_compile", path]
        : null
    if (!cmd) continue
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf-8" })
    if ((r.status ?? 1) !== 0) bad.push(`${fn}: ${String(r.stderr ?? "").slice(0, 160)}`)
  }
  return bad
}
