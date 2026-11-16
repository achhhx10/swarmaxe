/**
 * tests/forge-test.ts — verifie la gouvernance du Skill Forge sans toucher
 * au systeme : validations, rendu, detection de secret, syntaxe des scripts.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { renderSkill, skillRoot, syntaxCheck, validateSkill } from "../src/lib/skill-forge.ts"

const root = join(process.env.TMPDIR ?? "/tmp", `swarmaxe-forge-${Date.now()}`)
mkdirSync(root, { recursive: true })

const good: any = {
  name: "sqlite-busy-retry",
  description: "Diagnose and fix SQLITE_BUSY storms in a shared local SQLite database.",
  when_to_use: "A tool fails with 'database is locked' while several processes write.",
  when_not_to_use: "The database is remote, or the error is disk-full.",
  steps: ["List every process holding the file.", "Remove exclusive pragmas from the open path.", "Raise busy_timeout and retry with a longer budget."],
  verification: ["An 8-way parallel test ends with zero SQLITE_BUSY.", "PRAGMA quick_check returns ok."],
  scripts: [{ filename: "check.sh", content: "#!/bin/bash\nset -euo pipefail\ntrue\n" }],
}
const bad: any = { name: "Bad Name", description: "short", when_to_use: "", steps: ["one"], verification: [] }
const leaky: any = { ...good, name: "leaky", pitfalls: ["api_key = sk-" + "abcdefghijklmnopqrstuvwx"] }

let failures = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`)
  if (!cond) failures++
}

check("bon skill accepte", validateSkill(good, root).errors.length === 0)
check("mauvais skill refuse (>=4 erreurs)", validateSkill(bad, root).errors.length >= 4)
check("secret detecte", validateSkill(leaky, root).errors.some((e) => e.includes("secret")))
check(
  "sections imposees rendues",
  ["## When to use", "## When NOT to use", "## Steps", "## Verification"].every((h) => renderSkill(good).includes(h)),
)
check("scope global", skillRoot("global", "/tmp").endsWith(".config/opencode/skills"))
check("scope projet", skillRoot("project", "/tmp/p") === "/tmp/p/.opencode/skills")
writeFileSync(join(root, "broken.sh"), "if then fi\n")
check("syntaxe de script detectee", syntaxCheck(root, [{ filename: "broken.sh" }]).length === 1)

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? "FORGE-TEST OK" : `FORGE-TEST FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
