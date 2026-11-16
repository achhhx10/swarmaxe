/**
 * Adaptateur OpenCode V2 pour opencode-swarm-plugin 0.63.2.
 *
 * Le paquet amont genere un plugin API V1 : `export default async (input) => ({ tool, hooks })`.
 * OpenCode V2 exige `Plugin.define({ id, setup })` et un registre d'outils different.
 *
 * Ce fichier adapte les 74 outils V1 sans modifier `swarm-v1/legacy.ts` :
 *   - injection du nom (V1 le tire de la cle de l'objet, V2 l'exige dans l'outil)
 *   - conversion du raw shape zod `args` en JSON Schema `input`
 *   - traduction du resultat V1 (string | {output}) vers le contenu V2
 *   - construction d'un contexte V1-compatible pour les execute()
 *
 * Diagnostic : /tmp/swarmaxe-adapter.log
 */
import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { execSync } from "node:child_process"
import { spawn } from "node:child_process"

import legacy from "../swarmaxe-v1/legacy.ts"
import { renderSkill, validateSkill, skillRoot, syntaxCheck } from "../patches/skill-forge.ts"
import { splitForEmbedding, mergeMetadata, newParentId, mergeFindResults } from "../lib/memory.ts"

const LOG = "/tmp/swarmaxe-adapter.log"
const diag = (m: string) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`)
  } catch {}
}

/**
 * Les prompts generes par le paquet amont datent de son API d'origine et
 * demandent `Task(subagent_type="swarm-worker", ...)`. OpenCode V2 expose
 * `subagent(agent=...)` : sans reecriture le coordinateur cherche un outil
 * inexistant et le spawn echoue silencieusement.
 */
const SPAWN_TOOLS = new Set([
  "swarm_spawn_subtask",
  "swarm_subtask_prompt",
  "swarm_plan_prompt",
])

/**
 * Outils dont l'argument `response` doit etre du JSON strict. Les modeles
 * enveloppent souvent leur JSON dans un bloc Markdown, ou ajoutent une phrase
 * avant/apres ; les validateurs du CLI font un JSON.parse direct et refusent
 * ces sorties. On extrait donc l'objet avant de le transmettre.
 */
const JSON_TOOLS = new Set([
  "swarm_validate_decomposition",
  "structured_validate",
  "structured_parse_cell_tree",
  "structured_parse_decomposition",
  "structured_parse_evaluation",
])

/**
 * Retire les fences Markdown et isole le premier objet JSON equilibre.
 * Renvoie le texte inchange si aucun objet n'est trouve.
 */
function sanitizeJsonInput(text: string): string {
  if (typeof text !== "string") return text
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  if (s.startsWith("{") && s.endsWith("}")) return s
  const start = s.indexOf("{")
  if (start === -1) return s
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s
}

function rewriteSpawnText(text: string): string {
  if (!text || typeof text !== "string") return text
  return text
    .replaceAll('Task(subagent_type=\\"', 'subagent(agent=\\"')
    .replaceAll('Task(subagent_type="', 'subagent(agent="')
    .replaceAll("Task(subagent_type='", "subagent(agent='")
    .replaceAll("Task()", "subagent()")
    .replaceAll("Task tool", "subagent tool")
    // `expand` n'existe pas dans hivemind_find : le laisser ferait echouer
    // l'appel a la validation des arguments.
    .replace(/,\s*expand=true/g, "")
    .replace(/expand=true,\s*/g, "")
    .replace(/expand=true/g, "")
}

// Modele utilise par le hook de compaction V1 pour generer le prompt de
// continuation. Sa valeur par defaut (`anthropic/claude-haiku-4-5`) n'est pas
// connectee : on la remplace par un modele reellement disponible et gratuit.
process.env.OPENCODE_LITE_MODEL ||= "google/gemini-flash-latest"

type V1Ctx = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata: (i: { title?: string; metadata?: Record<string, unknown> }) => void
  ask: (i: { permission: string; patterns: string[]; always: string[] }) => Promise<void>
}

/** Convertit le raw shape zod V1 en JSON Schema pour le registre V2. */
function toInputSchema(rawShape: Record<string, unknown>): Record<string, unknown> {
  if (!rawShape || typeof rawShape !== "object" || Object.keys(rawShape).length === 0) {
    return { type: "object", properties: {}, additionalProperties: false }
  }
  try {
    const { $schema, ...rest } = z.toJSONSchema(z.object(rawShape as never), {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>
    // Les schemas V1 exigent `agent_name`, mais l'adaptateur fournit lui-meme
    // l'identite reelle (celle enregistree dans swarm-mail) : le modele n'a pas
    // a la connaitre. Sans cela, l'appel echoue a la validation V2 avec
    // "agent_name: Missing key" avant meme d'atteindre l'injection.
    const properties = (rest.properties ?? {}) as Record<string, unknown>
    if ("agent_name" in properties && Array.isArray(rest.required)) {
      rest.required = (rest.required as string[]).filter((key) => key !== "agent_name")
    }
    return { type: "object", additionalProperties: false, ...rest }
  } catch (err) {
    diag(`  schema illisible, repli permissif: ${err}`)
    return { type: "object", properties: {}, additionalProperties: true }
  }
}

/**
 * Bug amont 0.63.2 : `swarm tool swarm_complete` exige `start_time`, mais le
 * schema zod du plugin ne le declare pas. Le modele ne peut donc jamais le
 * fournir, et la cloture de toute sous-tache echoue. On memorise le premier
 * signalement d'avancement par bead et on complete le champ au moment du bilan,
 * afin que la duree calculee reste coherente.
 */
const startedAt = new Map<string, number>()

/**
 * Le paquet garde l'approbation de revue dans une `Map` en memoire du CLI
 * (`reviewStatus`). Or legacy.ts relance un processus `swarm` par appel :
 * l'approbation ecrite par swarm_review_feedback n'existe plus quand
 * swarm_complete la relit, et la tache reste indefiniment en `pending_review`.
 *
 * L'adaptateur vit dans le processus du serveur, qui lui persiste : il retient
 * les approbations et les rejoue. La revue reste donc obligatoire, on ne fait
 * que transporter l'etat a travers la frontiere de processus.
 */
const reviewApproved = new Map<string, number>()
const REVIEW_TTL_MS = 30 * 60 * 1000

/**
 * Identite de l'agent telle qu'enregistree par `swarmmail_init` (sessionID ->
 * nom). swarm-mail attribue un nom genere (WarmMoon, BlueCloud, ...) qui n'a
 * rien a voir avec le nom de l'agent OpenCode. Les completions envoyaient donc
 * `agent_name: "swarm-worker"` alors que le registre connaissait un autre nom,
 * et chaque tache terminee produisait :
 *   "WARNING: Agent 'swarm-worker' was NOT registered in swarm-mail".
 * On retient le nom reellement enregistre pour l'utiliser ensuite.
 */
const agentNames = new Map<string, string>()

/** Nom d'agent renvoye par swarmmail_init, si la reponse en contient un. */
function readAgentName(result: unknown): string | undefined {
  try {
    let obj: any = result
    for (let i = 0; i < 2 && typeof obj === "string"; i++) obj = JSON.parse(obj)
    if (!obj || typeof obj !== "object") return undefined
    const name = obj.agent_name ?? obj.data?.agent_name
    return typeof name === "string" && name ? name : undefined
  } catch {
    return undefined
  }
}

/** Extrait {task_id, status} d'une reponse d'outil (chaine JSON ou objet). */
function readReviewOutcome(result: unknown): { taskId?: string; status?: string } {
  try {
    // runSwarmCli renvoie deja du JSON serialise, parfois doublement encode.
    let obj: any = result
    for (let i = 0; i < 2 && typeof obj === "string"; i++) obj = JSON.parse(obj)
    if (!obj || typeof obj !== "object") return {}
    const taskId = obj.task_id ?? obj.taskId ?? obj.data?.task_id
    const status = obj.status ?? obj.data?.status
    return {
      taskId: typeof taskId === "string" ? taskId : undefined,
      status: typeof status === "string" ? status : undefined,
    }
  } catch {
    return {}
  }
}

/** Vrai si la revue de cette tache a ete approuvee pendant cette session. */
function isReviewApproved(taskId: string | undefined): boolean {
  if (!taskId) return false
  const at = reviewApproved.get(taskId)
  if (at === undefined) return false
  if (Date.now() - at > REVIEW_TTL_MS) {
    reviewApproved.delete(taskId)
    return false
  }
  return true
}

/**
 * Outils declares par le plugin mais inexistants sous ce nom dans le CLI
 * `swarm` de la 0.63.2. On les redirige vers le vrai nom et on reconstruit
 * leurs arguments, plutot que de les laisser echouer.
 */
type Alias = { cli: string; args?: (a: any, dir: string, agent: string) => any }

const CLI_ALIASES: Record<string, Alias> = {
  beads_link_thread: { cli: "hive_link_thread" },
  // Les trois swarm_get_*_insights sont implementes nativement dans execute()
  // (recherche semantique hivemind) : le CLI 0.63.2 ne les expose plus, et
  // swarm_insights n'a ni metrique strategie, ni fichier, ni patterns.
  // Le plugin V1 execute swarm_complete via son propre spawn, sans le PATH
  // enrichi : `tsc` est alors introuvable et la porte de verification echoue
  // a tort. On le route par runSwarmCli, qui ajoute <projet>/node_modules/.bin.
  swarm_complete: { cli: "swarm_complete" },
  // La porte de verification (tsc + tests) est utile hors de swarm_complete.
  // Elle est lourde : on la garde sur le CLI (timeout 900 s) et jamais
  // in-process, pour ne pas bloquer la boucle d'evenements du service.
  swarm_verify: { cli: "swarm_verify" },
  // Le CLI n'expose que swarm_complete : on reconstruit son contrat complet.
  // La verification (tsc + tests) reste active : runSwarmCli enrichit le PATH
  // avec <projet>/node_modules/.bin pour que la porte trouve les binaires.
  swarm_complete_subtask: {
    cli: "swarm_complete",
    args: (a, dir, agent) => ({
      bead_id: a?.bead_id,
      project_key: dir,
      agent_name: agent,
      summary: a?.task_result ?? "Sous-tache terminee",
      files_touched: a?.files_touched,
      start_time: startedAt.get(a?.bead_id) ?? Date.now(),
      skip_review: a?.skip_review,
    }),
  },
}

/** Requetes semantiques des trois outils d'insights du plugin V1. */
const INSIGHT_QUERIES: Record<string, (args: any) => string> = {
  swarm_get_strategy_insights: (args) =>
    `strategy decomposition success rate feature-based file-based risk-based ${
      typeof args?.task === "string" ? args.task : ""
    }`.trim(),
  swarm_get_file_insights: (args) =>
    `file gotchas pitfalls bugs ${
      Array.isArray(args?.files) ? args.files.join(" ") : ""
    }`.trim(),
  swarm_get_pattern_insights: () =>
    "failure patterns type errors timeouts conflicts test failures retries",
}

/** Execute un outil du CLI swarm avec la meme convention que legacy.ts. */
function cliErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const s = value.trim()
    if (!s.startsWith("{")) return undefined
    try {
      return cliErrorMessage(JSON.parse(s))
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const obj = value as any
  // Un resultat de validation (`{valid:false, details}`) est une reponse
  // metier normale : le planner doit pouvoir lire les details et corriger,
  // pas recevoir une exception "Schema validation failed".
  if (obj.valid === false) return undefined
  if (obj.success === false) {
    return typeof obj.error === "string" ? obj.error : JSON.stringify(obj.error ?? obj)
  }
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error
  return undefined
}

/** Extrait le premier objet/tableau JSON equilibre d'une sortie CLI. */
function parseCliJson(text: string): any | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {}
  for (let start = 0; start < trimmed.length; start++) {
    const first = trimmed[start]
    if (first !== "{" && first !== "[") continue
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === "\\") escaped = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') {
        inString = true
        continue
      }
      if (c === "{" || c === "[") stack.push(c)
      else if (c === "}" || c === "]") {
        const open = stack.pop()
        if ((c === "}" && open !== "{") || (c === "]" && open !== "[")) break
        if (stack.length === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

/**
 * `swarm_init` du CLI 0.63.2 verifie la presence des binaires externes `hive`
 * et `cass`, alors que les outils hive_* et cass_* sont embarques dans le
 * plugin et fonctionnent sans eux. On corrige le rapport pour ne pas annoncer
 * a tort que le suivi de taches et l'historique sont desactives.
 */
function correctSwarmInit(text: string): string {
  const report = parseCliJson(text)
  if (!report || typeof report !== "object" || Array.isArray(report)) return text

  const availability = report.tool_availability
  if (availability && typeof availability === "object") {
    for (const key of ["hive", "cass", "hivemind", "swarm-mail", "semantic-memory"]) {
      if (availability[key]) availability[key] = { available: true, fallback: null }
    }
  }

  if (Array.isArray(report.degraded_features)) {
    report.degraded_features = report.degraded_features.filter(
      (f: unknown) =>
        ![
          "issue tracking",
          "progress persistence",
          "historical context from past sessions",
          "agent communication",
          "file reservations",
        ].includes(String(f)),
    )
  }

  if (Array.isArray(report.warnings)) {
    report.warnings = report.warnings.filter(
      (w: unknown) =>
        !String(w).includes("beads (bd) not available") &&
        !String(w).includes("agent-mail not available") &&
        !String(w).includes("cass"),
    )
  }

  if (report.recommendations && typeof report.recommendations === "object") {
    report.recommendations.beads = "[OK] Use hive_* tools for all task tracking (embedded Hive adapter)"
    report.recommendations.agent_mail = "[OK] Use swarm-mail tools for coordination (embedded)"
    if (typeof report.recommendations.isolation === "string") {
      report.recommendations.isolation = report.recommendations.isolation.replace(/^[^A-Za-z]*/, "[OK] ")
      if (!report.recommendations.isolation.startsWith("[OK]")) {
        report.recommendations.isolation = `[OK] ${report.recommendations.isolation}`
      }
    }
  }

  if (typeof report.report === "string") {
    const header = report.report.split("\n")[0] || "Tool Availability:"
    const lines = [header]
    const order = ["semantic-memory", "cass", "hivemind", "hive", "beads", "swarm-mail", "agent-mail"]
    for (const tool of order) {
      const info = availability?.[tool]
      if (!info) continue
      if (tool === "beads") {
        lines.push("  [--] beads (deprecated; use hive)")
      } else if (tool === "agent-mail") {
        lines.push("  [--] agent-mail (deprecated; use swarm-mail)")
      } else if (info.available) {
        lines.push(`  [OK] ${tool}${tool === "hive" || tool === "cass" ? " (embedded)" : ""}`)
      } else {
        lines.push(`  [--] ${tool} -> ${info.fallback ?? "unavailable"}`)
      }
    }
    report.report = lines.join("\n")
  }

  return JSON.stringify(report, null, 2)
}

/** Rend une session cass (JSONL) sans passer par l'alias CLI `cass_view` :
 *  dans 0.63.2 cet alias est ecrase par un alias deprecated vers hivemind_get
 *  (qui attend un `id`), d'ou l'erreur "undefined cannot be passed ...". */
function nativeCassView(name: "cass_view" | "cass_expand", args: any): string {
  const path = typeof args?.path === "string" ? args.path : ""
  if (!path) return JSON.stringify({ error: "path is required" }, null, 2)
  if (!existsSync(path)) return JSON.stringify({ error: `Session file not found: ${path}` }, null, 2)

  let raw = ""
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    return JSON.stringify(
      { error: `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` },
      null,
      2,
    )
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return `Session ${path} is empty.`

  const requested =
    typeof args?.line === "number" && Number.isFinite(args.line) ? Math.trunc(args.line) : undefined
  const context = Math.max(
    0,
    Math.trunc(
      typeof args?.context === "number" ? args.context : name === "cass_expand" ? 5 : 3,
    ),
  )
  const start = requested === undefined ? 1 : Math.max(1, requested - context)
  const end =
    requested === undefined
      ? Math.min(lines.length, 400)
      : Math.min(lines.length, requested + context)

  const format = (line: string, n: number) => {
    try {
      const obj = JSON.parse(line)
      const role = obj.role ?? obj.event_type ?? obj.type ?? "event"
      const content = obj.content ?? obj.payload ?? obj.message ?? obj.text
      const text = typeof content === "string" ? content : JSON.stringify(content)
      const ts = typeof obj.timestamp === "string" ? ` ${obj.timestamp}` : ""
      return `${n}: [${role}${ts}] ${text}`
    } catch {
      return `${n}: ${line}`
    }
  }

  const body = lines
    .slice(start - 1, end)
    .map((line, i) => format(line, start + i))
    .join("\n")
  const header = `Session: ${path}\nTotal lines: ${lines.length}${
    requested !== undefined ? ` | around line ${requested} (context ${context})` : ""
  }`
  const footer =
    requested === undefined && lines.length > end
      ? `\n… ${lines.length - end} more line(s); pass line=<n> to jump.`
      : ""
  return `${header}\n\n${body}${footer}`
}

/** Compte les sessions cass .jsonl pour corriger cass_health / cass_stats. */
function countCassSessions(): number {
  try {
    const dir = join(homedir(), ".config", "swarm-tools", "sessions")
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter((file) => file.endsWith(".jsonl")).length
  } catch {
    return 0
  }
}

/**
 * Un spawn sans limite de temps a deja laisse un `swarm tool ...` tourner
 * 8 h 42 en consommant 400 min de CPU (aucun kill quand l'appel est annule).
 * On borne donc chaque appel, plus large pour les outils lents (revue,
 * verification, decomposition) qui lancent tsc/bun test.
 */
const CLI_TIMEOUT_MS = 180_000
const CLI_TIMEOUT_HEAVY_MS = 900_000
const HEAVY_TOOLS = new Set([
  "swarm_complete",
  "swarm_complete_subtask",
  "swarm_review",
  "swarm_review_feedback",
  "swarm_verify",
  "swarm_decompose",
  "swarm_validate_decomposition",
  "swarm_spawn_subtask",
  "swarm_plan_prompt",
  "swarm_subtask_prompt",
  "swarm_evaluation_prompt",
  "swarm_adversarial_review",
  "skills_execute",
  // Reindexation complete : peut prendre plusieurs minutes (embeddings Ollama).
  "hivemind_index",
  "cass_index",
  "hivemind_sync",
])

function runSwarmCliOnce(
  toolName: string,
  args: any,
  dir: string,
  sessionID: string,
  messageID: string,
  agent: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = args && Object.keys(args).length ? ["tool", toolName, "--json", JSON.stringify(args)] : ["tool", toolName]
    // La porte de verification du paquet lance `tsc --noEmit` et `bun test` dans
    // le repertoire du projet. Le service OpenCode demarre hors shell : ni
    // ~/.bun/bin ni <projet>/node_modules/.bin n'y sont, et la verification
    // echoue sur "command not found: tsc". On les ajoute pour le CLI.
    const binPaths = [join(dir, "node_modules", ".bin"), join(homedir(), ".bun", "bin")].join(":")
    const proc = spawn(process.platform === "win32" ? "swarm.cmd" : "swarm", payload, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${binPaths}:${process.env.PATH ?? ""}`,
        OPENCODE_SESSION_ID: sessionID,
        OPENCODE_MESSAGE_ID: messageID,
        OPENCODE_AGENT: agent,
        SWARM_PROJECT_DIR: dir,
        // Sans terminal, un `git push` https sans identifiants peut rester
        // bloque sur une demande d'utilisateur : on echoue immediatement.
        GIT_TERMINAL_PROMPT: "0",
      },
    })
    let out = ""
    let err = ""
    const limitMs = HEAVY_TOOLS.has(toolName) ? CLI_TIMEOUT_HEAVY_MS : CLI_TIMEOUT_MS
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      diag(`  ${toolName}: delai depasse (${limitMs / 1000}s), processus tue`)
      try {
        proc.kill("SIGKILL")
      } catch {}
    }, limitMs)
    proc.stdout.on("data", (d) => (out += d))
    proc.stderr.on("data", (d) => (err += d))
    proc.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on("close", () => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${toolName}: delai depasse (${limitMs / 1000}s), processus tue`))
        return
      }
      const parsed = parseCliJson(out)
      if (parsed === undefined) {
        out.trim() ? resolve(out.trim()) : reject(new Error(err.trim() || `swarm ${toolName}: reponse illisible`))
        return
      }
      const failure = cliErrorMessage(parsed) ?? cliErrorMessage(parsed?.data)
      if (failure) {
        // Remonter les blockers de verification : sans cela, le worker ne
        // voit qu'un "Verification Gate FAILED" et ne sait pas quoi corriger.
        const blockers = (parsed as any)?.verification?.blockers ?? (parsed as any)?.data?.verification?.blockers
        const detail = Array.isArray(blockers) && blockers.length ? `\n- ${blockers.join("\n- ")}` : ""
        reject(new Error(`${failure}${detail}`))
        return
      }
      resolve(parsed.data !== undefined ? JSON.stringify(parsed.data, null, 0) : JSON.stringify(parsed, null, 0))
    })
  })
}

/**
 * Le CLI ouvre la base libSQL a chaque appel. Deux outils lances en parallele
 * (reserve + progress, par exemple) peuvent se heurter a SQLITE_BUSY.
 *
 * Le CLI attend jusqu'a busy_timeout (15 s) avant de rendre la main : une
 * reprise plus courte que ce delai ne peut pas gagner contre le verrou qu'elle
 * attend. On reessaie donc plus longtemps (0,5 s -> 8 s, ~18 s cumules).
 */
const RETRYABLE_DB = /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i

async function runSwarmCli(
  toolName: string,
  args: any,
  dir: string,
  sessionID: string,
  messageID: string,
  agent: string,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await runSwarmCliOnce(toolName, args, dir, sessionID, messageID, agent)
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!RETRYABLE_DB.test(msg) || attempt === 3) throw err
      const delay = Math.min(500 * 2 ** attempt, 8000)
      diag(`  ${toolName}: SQLITE_BUSY, nouvelle tentative dans ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

/** Enveloppe un outil V1 pour le registre V2, lie au projet de son setup. */
function adapt(name: string, tool: any, projectDir: string) {
  // Les outils qui declarent un agent_name recevront l'identite reellement
  // enregistree dans swarm-mail plutot que le nom de l'agent OpenCode.
  let takesAgentName = false
  try {
    // `swarmmail_release_agent` utilise agent_name comme CIBLE (override
    // coordinateur), pas comme identite de l'appelant : ne pas l'ecraser.
    takesAgentName =
      name !== "swarmmail_release_agent" &&
      !!tool?.args &&
      typeof tool.args === "object" &&
      "agent_name" in tool.args
  } catch {
    takesAgentName = false
  }

  const input = toInputSchema(tool?.args)
  // Le prompt coordinateur manipule `issues` comme un tableau d'objets, alors
  // que le schema V1 le declare en chaine JSON. On accepte les deux : la
  // normalisation vers une chaine se fait dans execute().
  if (name === "swarm_review_feedback" && input.properties && typeof input.properties === "object") {
    const props = input.properties as Record<string, unknown>
    if (props.issues) {
      props.issues = {
        type: ["string", "array"],
        items: { type: "object", additionalProperties: true },
        description: "Review issues: JSON string or array of objects (both accepted)",
      }
    }
  }

  // Le plugin V1 et le CLI 0.63.2 ont diverge sur les skills : `skill_name` /
  // `script_name` cote V1, `skill` / `script` cote CLI, et des champs requis
  // par le CLI absents du schema V1 (`body`, `confirm`, `file`). On expose un
  // sur-ensemble puis on normalise dans execute() : les anciens prompts comme
  // les appels conformes au CLI fonctionnent.
  const skillsSchema: Record<string, { properties: Record<string, unknown>; required?: string[] }> = {
    skills_list: {
      properties: { source: { type: "string" }, tag: { type: "string" } },
    },
    skills_use: {
      properties: {
        name: { type: "string" },
        context: { type: "string" },
        include_scripts: { type: "boolean" },
      },
      required: ["name"],
    },
    skills_execute: {
      properties: {
        skill_name: { type: "string" },
        script_name: { type: "string" },
        skill: { type: "string" },
        script: { type: "string" },
        args: { type: ["string", "array"], items: { type: "string" } },
        timeout_ms: { type: "number" },
      },
    },
    skills_read: {
      properties: {
        name: { type: "string" },
        skill: { type: "string" },
        file: { type: "string" },
      },
    },
    skills_create: {
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        scope: { type: "string" },
        body: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
        directory: { type: "string" },
      },
      required: ["name", "description"],
    },
    skills_update: {
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        body: { type: "string" },
        description: { type: "string" },
        append_body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        add_tags: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
    skills_delete: {
      properties: { name: { type: "string" }, confirm: { type: "boolean" } },
      required: ["name"],
    },
    skills_add_script: {
      properties: {
        skill_name: { type: "string" },
        skill: { type: "string" },
        script_name: { type: "string" },
        content: { type: "string" },
        executable: { type: "boolean" },
      },
      required: ["content"],
    },
  }
  const skillSchema = skillsSchema[name]
  if (skillSchema) {
    input.properties = skillSchema.properties
    input.required = skillSchema.required ?? []
    input.additionalProperties = false
  }

  return {
    name,
    description: tool?.description ?? `Swarm tool: ${name}`,
    input,
    async execute(rawArgs: any, ctx: any) {
      const dir = ctx?.directory ?? ctx?.location?.directory ?? projectDir
      const args: any = { ...(rawArgs ?? {}) }
      diag(`  -> ${name} ${JSON.stringify(Object.keys(args))}`)

      // Les validateurs du CLI n'acceptent que du JSON brut.
      if (JSON_TOOLS.has(name) && typeof args.response === "string") {
        const before = args.response.length
        args.response = sanitizeJsonInput(args.response)
        if (args.response.length !== before) {
          diag(`  ${name}: JSON assaini (${before} -> ${args.response.length} octets)`)
        }
      }

      // Le portail de verification appelle `bun test <chemin>` sans prefixe
      // `./`. Bun 1.3 traite alors le premier segment comme un nom de paquet
      // et echoue ("Cannot find module ... from ''"). On normalise les chemins
      // relatifs pour que les tests soient reellement decouverts et executes.
      if ((name === "swarm_complete" || name === "swarm_verify") && Array.isArray(args.files_touched)) {
        args.files_touched = args.files_touched.map((f: any) =>
          typeof f === "string" && f.length > 0 && !f.startsWith("/") && !f.startsWith("./") && !f.startsWith("../")
            ? `./${f}`
            : f,
        )
      }

      // Le CLI attend `issues` sous forme de chaine JSON, alors que les agents
      // et le prompt coordinateur le manipulent comme un tableau d'objets.
      if (name === "swarm_review_feedback" && Array.isArray(args.issues)) {
        args.issues = JSON.stringify(args.issues)
      }

      // Aligner les noms de champs des skills sur le CLI 0.63.2.
      if (name.startsWith("skills_")) normalizeSkillsArgs(name, args)

      // hive_sync : `auto_pull` vaut true cote CLI, ce qui fait
      // `git stash push -u` + `git pull --rebase` dans le depot du projet.
      // Dans un service sans terminal c'est risque et inutile : on ne tire
      // jamais implicitement.
      if (name === "hive_sync" && args.auto_pull === undefined) {
        args.auto_pull = false
      }

      // Les modeles passent parfois l'objet cell entier, ou un id entoure de
      // guillemets / retours ligne, dans `id` : d'ou les
      // "No cell found matching ID '{'". On normalise avant l'appel CLI.
      for (const key of ["id", "bead_id", "task_id", "epic_id", "parent_id"]) {
        const value = args[key]
        if (typeof value !== "string") continue
        if (/^\s*[{[]/.test(value)) {
          const parsed = parseCliJson(value) as any
          const inner = parsed?.id ?? parsed?.bead_id ?? parsed?.cell_id ?? parsed?.task_id
          if (typeof inner === "string" && inner.length > 0) {
            diag(`  ${name}: ${key} extrait d'un JSON (${inner})`)
            args[key] = inner
          }
        } else if (value !== value.trim() || /^["'`]|["'`]$/.test(value)) {
          args[key] = value.trim().replace(/^["'`]+|["'`]+$/g, "")
          diag(`  ${name}: ${key} normalise (${args[key]})`)
        }
      }

      if (name === "swarm_progress" && typeof args.bead_id === "string") {
        if (!startedAt.has(args.bead_id)) startedAt.set(args.bead_id, Date.now())
      }
      if (name === "swarm_complete" && typeof args.start_time !== "number") {
        args.start_time = startedAt.get(args.bead_id) ?? Date.now()
        diag(`  ${name}: start_time injecte (${args.start_time})`)
      }

      // Rejoue une approbation de revue obtenue plus tot dans cette session :
      // le CLI ne peut pas la conserver d'un processus a l'autre.
      if (
        (name === "swarm_complete" || name === "swarm_complete_subtask") &&
        args.skip_review !== true &&
        isReviewApproved(args.bead_id)
      ) {
        args.skip_review = true
        diag(`  ${name}: skip_review rejoue (revue approuvee pour ${args.bead_id})`)
      }

      const v1: V1Ctx = {
        sessionID: ctx?.sessionID ?? "",
        messageID: ctx?.messageID ?? "",
        agent: ctx?.agent ?? "build",
        directory: dir,
        worktree: ctx?.worktree ?? dir,
        abort: ctx?.abort ?? new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      }

      // Identite reelle de l'agent : swarmmail_init attribue un nom genere et
      // c'est celui-la que le registre connait. Sans cette substitution, chaque
      // completion avertissait "Agent '<agent opencode>' was NOT registered".
      let registeredAgent = agentNames.get(v1.sessionID)
      // Un redemarrage du service (ou un rechargement du plugin) vide la Map.
      // Pour tout outil qui transporte agent_name, on retrouve l'identite deja
      // enregistree en reinitialisant la session : swarmmail_init est idempotent.
      if (!registeredAgent && (takesAgentName || name.startsWith("swarmmail_")) && name !== "swarmmail_init") {
        try {
          const initText = await runSwarmCli(
            "swarmmail_init",
            { project_path: dir, task_description: `${name} identity fallback` },
            dir,
            v1.sessionID,
            v1.messageID,
            v1.agent,
          )
          const discovered = readAgentName(initText)
          if (discovered) {
            registeredAgent = discovered
            agentNames.set(v1.sessionID, discovered)
            diag(`  ${name}: identite retrouvee = ${discovered}`)
          }
        } catch (err) {
          diag(`  ${name}: identite introuvable (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      const agentName = registeredAgent ?? v1.agent
      if (takesAgentName && name !== "swarmmail_init" && args.agent_name !== agentName) {
        if (args.agent_name !== undefined) {
          diag(`  ${name}: agent_name ${args.agent_name} -> ${agentName}`)
        }
        args.agent_name = agentName
      }

      // Les trois insights du plugin V1 n'ont plus d'equivalent CLI. On
      // interroge la memoire semantique, qui alimente les fonctions internes
      // getStrategyInsights/getFileInsights/getPatternInsights.
      const insightQuery = INSIGHT_QUERIES[name]?.(args)
      if (insightQuery) {
        try {
          const text = await runSwarmCli(
            "hivemind_find",
            { query: insightQuery, limit: 5 },
            dir,
            v1.sessionID,
            v1.messageID,
            agentName,
          )
          const parsed = parseCliJson(text) as any
          const data = parsed?.data ?? parsed
          const raw = Array.isArray(data) ? data : data?.results ?? data?.memories ?? []
          const requestedFiles: string[] = Array.isArray(args?.files)
            ? args.files.filter((file: unknown): file is string => typeof file === "string")
            : []
          const insights = (Array.isArray(raw) ? raw : [])
            .map((entry: any) => ({
              id: entry?.id ?? entry?.memory?.id,
              content: entry?.content ?? entry?.memory?.content ?? entry?.text,
              score: entry?.score,
              metadata: entry?.metadata,
            }))
            .filter((entry: any) => typeof entry.content === "string" && entry.content.length > 0)
            .map((entry: any) => {
              if (name !== "swarm_get_file_insights" || requestedFiles.length === 0) return entry
              const haystack = JSON.stringify(entry)
              const matched = requestedFiles.filter((file: string) => {
                const base = file.split("/").pop() ?? file
                return haystack.includes(file) || (base.length > 3 && haystack.includes(base))
              })
              return matched.length > 0 ? { ...entry, matched_files: matched } : entry
            })
          const hasExactFileMatch = insights.some(
            (entry: any) => Array.isArray(entry.matched_files) && entry.matched_files.length > 0,
          )
          const note =
            insights.length === 0
              ? "No matching historical insight yet; insights accumulate as swarm outcomes and memories are stored."
              : name === "swarm_get_file_insights" && requestedFiles.length > 0 && !hasExactFileMatch
                ? "No exact historical outcome for the requested files; showing semantically related sessions."
                : undefined
          return {
            content: JSON.stringify(
              {
                tool: name,
                query: insightQuery,
                source: "hivemind",
                count: insights.length,
                insights,
                note,
              },
              null,
              2,
            ),
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          diag(`  <- ${name} ECHEC (hivemind_find): ${msg}`)
          return {
            content: JSON.stringify(
              { tool: name, query: insightQuery, source: "hivemind", count: 0, insights: [], error: msg },
              null,
              2,
            ),
          }
        }
      }

      // Outils rediriges vers un autre nom de CLI.
      const fix = (s: string) => {
        if (!SPAWN_TOOLS.has(name)) return s
        let rewritten = rewriteSpawnText(s)
        // Le prompt amont contient un `$PWD` litteral et un placeholder
        // `{subtask_title}` : on les resout pour que le worker puisse copier
        // les commandes sans ambiguite. Les valeurs sont echappees JSON car
        // le prompt est lui-meme serialise dans une chaine JSON.
        const escapedDir = JSON.stringify(dir).slice(1, -1)
        rewritten = rewritten.replace(/\$PWD/g, () => escapedDir)
        if (typeof args?.subtask_title === "string" && args.subtask_title.length > 0) {
          const escapedTitle = JSON.stringify(args.subtask_title).slice(1, -1)
          rewritten = rewritten.replaceAll("{subtask_title}", escapedTitle)
        }
        return rewritten
      }
      const alias = CLI_ALIASES[name]
      if (alias) {
        const payload = alias.args ? alias.args(args, dir, agentName) : args
        if (name === "swarm_complete_subtask") {
          diag(`  ${name}: dir=${dir} project_key=${(payload as any)?.project_key} bead=${(payload as any)?.bead_id} agent=${agentName}`)
        }
        try {
          const text = await runSwarmCli(alias.cli, payload, dir, v1.sessionID, v1.messageID, agentName)
          diag(`  ${name} -> ${alias.cli}`)
          return { content: fix(text) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          diag(`  <- ${name} ECHEC (-> ${alias.cli}): ${msg}`)
          throw new Error(`${name} (-> ${alias.cli}): ${msg}`)
        }
      }

      // `cass_view`/`cass_expand` du CLI 0.63.2 sont ecrases par des alias
      // deprecated vers hivemind_get (qui attend `id`) : on lit directement le
      // fichier JSONL pour conserver le contrat path/line du plugin V1.
      if (name === "cass_view" || name === "cass_expand") {
        return { content: nativeCassView(name, args) }
      }

      let result: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          result = await tool.execute(args ?? {}, v1)
          // Le plugin V1 renvoie parfois une erreur metier sous forme de
          // chaine JSON (`{"error":"..."}`) sans la lever. On la traite comme
          // un echec pour pouvoir reessayer sur un verrou SQLite transitoire.
          // Les outils `structured_*` renvoient volontairement
          // `{success:false, details, feedback}` quand l'entree n'est pas
          // parsable : c'est une reponse metier, pas un echec du CLI. On ne
          // la convertit pas en exception pour laisser l'appelant corriger.
          const nested = name.startsWith("structured_") ? undefined : cliErrorMessage(result)
          if (nested) throw new Error(nested)
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // Un export hive deja ecrit localement ne doit pas etre signale
          // comme un echec d'outil quand seul le `git push` echoue (service
          // sans identifiants git pour un remote https).
          if (name === "hive_sync" && /Failed to push/i.test(msg)) {
            diag(`  ${name}: push git ignore (${msg})`)
            return {
              content:
                `Hive exporte localement (.hive/). Le push git a echoue : ${msg}\n` +
                "Configure un remote SSH ou un credential helper pour que le push parte.",
            }
          }
          if (!RETRYABLE_DB.test(msg) || attempt === 3) {
            diag(`  <- ${name} ECHEC: ${msg}`)
            throw new Error(`${name}: ${msg}`)
          }
          const delay = Math.min(500 * 2 ** attempt, 8000)
          diag(`  ${name}: SQLITE_BUSY (tool), nouvelle tentative dans ${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
      if (result === undefined) {
        throw new Error(`${name}: aucune reponse apres reprise`)
      }

      // Retenir l'identite enregistree par swarm-mail pour les appels suivants.
      if (name === "swarmmail_init") {
        const registered = readAgentName(result)
        if (registered && registered !== agentNames.get(v1.sessionID)) {
          agentNames.set(v1.sessionID, registered)
          diag(`  ${name}: identite retenue = ${registered}`)
        }
      }

      // Retenir l'approbation de revue pour la rejouer a la completion.
      // Si la reponse du CLI n'expose pas task_id/status, on retombe sur les
      // arguments d'entree : l'approbation ne doit jamais etre perdue.
      if (name === "swarm_review_feedback") {
        const outcome = readReviewOutcome(result)
        const approvedTask = outcome.taskId ?? (typeof args.task_id === "string" ? args.task_id : undefined)
        const approvedStatus = outcome.status ?? (typeof args.status === "string" ? args.status : undefined)
        if (approvedTask && approvedStatus === "approved") {
          reviewApproved.set(approvedTask, Date.now())
          diag(`  ${name}: approbation retenue pour ${approvedTask}`)
        }
      }

      if (typeof result === "string") {
        let text = result
        // cass_health/cass_stats sont des alias vers hivemind_stats dans le
        // CLI : le compteur `sessions` reste a 0 alors que cass_index a bien
        // indexe des fichiers. On renseigne le nombre reel de sessions .jsonl.
        if (name === "cass_health" || name === "cass_stats" || name === "hivemind_stats") {
          const report = parseCliJson(text) as any
          if (report && typeof report === "object" && !Array.isArray(report)) {
            const count = countCassSessions()
            if (report.sessions && typeof report.sessions === "object") {
              report.sessions.total_sessions = count
              if (report.sessions.by_agent && typeof report.sessions.by_agent === "object") {
                for (const key of Object.keys(report.sessions.by_agent)) {
                  const entry = report.sessions.by_agent[key]
                  if (entry && typeof entry === "object") entry.sessions = count
                }
              }
            }
            report.session_files = count
            text = JSON.stringify(report, null, 2)
          }
        }
        return { content: fix(name === "swarm_init" ? correctSwarmInit(text) : text) }
      }
      if (result && typeof (result as any).output === "string") {
        return { content: fix((result as any).output), metadata: (result as any).metadata }
      }
      return { content: fix(JSON.stringify(result)) }
    },
  }
}

/**
 * Traduit les arguments des skills du plugin V1 vers le schema reel du CLI.
 * Sans cela, skills_read / skills_add_script / skills_execute recevaient
 * `undefined` (le CLI lit `skill` / `script`) et skills_delete ne pouvait
 * jamais confirmer la suppression (`confirm` absent du schema V1).
 */
function normalizeSkillsArgs(name: string, args: any): void {
  const clear = () => {
    for (const key of Object.keys(args)) delete args[key]
  }
  switch (name) {
    case "skills_read": {
      const skill = args.skill ?? args.skill_name ?? args.name
      const file = args.file ?? "SKILL.md"
      clear()
      if (skill !== undefined) args.skill = skill
      args.file = file
      return
    }
    case "skills_execute": {
      const skill = args.skill ?? args.skill_name ?? args.name
      const script = args.script ?? args.script_name
      const cliArgs = args.args
      const timeout = args.timeout_ms
      clear()
      if (skill !== undefined) args.skill = skill
      if (script !== undefined) args.script = script
      if (cliArgs !== undefined) args.args = cliArgs
      if (timeout !== undefined) args.timeout_ms = timeout
      return
    }
    case "skills_add_script": {
      const skill = args.skill ?? args.skill_name ?? args.name
      const scriptName = args.script_name ?? args.script
      const content = args.content
      const executable = args.executable
      clear()
      if (skill !== undefined) args.skill = skill
      if (scriptName !== undefined) args.script_name = scriptName
      args.content = content ?? ""
      args.executable = executable ?? true
      return
    }
    case "skills_delete": {
      const skillName = args.name
      const confirm = args.confirm ?? true
      clear()
      if (skillName !== undefined) args.name = skillName
      args.confirm = confirm
      return
    }
    case "skills_create": {
      // Le CLI attend `body` (obligatoire) et `directory` (enum), pas `scope`.
      let directory = args.directory
      if (directory === ".opencode/skills") directory = ".opencode/skill"
      if (directory === undefined && args.scope === "global") directory = "global"
      const next: any = {
        name: args.name,
        description: args.description,
        body: args.body ?? args.content ?? "",
      }
      if (args.tags !== undefined) next.tags = args.tags
      if (args.tools !== undefined) next.tools = args.tools
      if (directory !== undefined) next.directory = directory
      clear()
      Object.assign(args, next)
      return
    }
    case "skills_list": {
      const tag = args.tag
      clear()
      if (tag !== undefined) args.tag = tag
      return
    }
    case "skills_use": {
      const skillName = args.name
      const includeScripts = args.include_scripts
      clear()
      if (skillName !== undefined) args.name = skillName
      if (includeScripts !== undefined) args.include_scripts = includeScripts
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// OUTILS AMONT ADDITIONNELS (2026-11-15)
//
// Le wrapper V1 n'expose que 74 des 117 outils du paquet. On ajoute ici une
// selection strictement en lecture / diagnostic, executee in-process via le
// meme bundle que la voie rapide de legacy.ts. Aucun outil lourd ni mutant
// dangereux : ni worktrees, ni queue, ni mandates, ni swarm_branch/return.
// ---------------------------------------------------------------------------
function resolveSwarmEntry(): string {
  if (process.env.SWARM_PKG_ENTRY) return process.env.SWARM_PKG_ENTRY
  const roots: string[] = []
  try {
    roots.push(execSync("npm root -g", { encoding: "utf-8" }).trim())
  } catch {}
  roots.push(
    join(homedir(), ".bun", "install", "global", "node_modules"),
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/usr/lib/node_modules",
  )
  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, "opencode-swarm-plugin", "dist", "index.js")
    if (existsSync(candidate)) return candidate
  }
  return ""
}
const SWARM_PKG_ENTRY = resolveSwarmEntry()

const EXTRA_TOOL_NAMES = [
  "hive_projects",
  "swarm_diagnose",
  "swarm_query", // SELECT uniquement, 50 lignes max (garde-fou du paquet)
  "swarm_discover_tools",
  "swarm_recover",
  "swarm_insights",
  "swarm_analytics",
  "swarm_get_versions",
  "repo_structure",
  "repo_tree",
  "repo_readme",
  "repo_file",
  "skills_reload",
]

let extraTools: Record<string, any> | null = null
let extraLoadFailed = false
let extraLoading: Promise<void> | null = null

async function loadExtraTools(dir: string): Promise<void> {
  if (extraTools || extraLoadFailed) return
  if (!extraLoading) {
    extraLoading = (async () => {
      try {
        if (!SWARM_PKG_ENTRY) throw new Error("paquet amont introuvable (npm root -g / SWARM_PKG_ENTRY)")
        const mod: any = await Promise.race([
          import(pathToFileURL(SWARM_PKG_ENTRY).href),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("import timeout (20s)")), 20_000),
          ),
        ])
        const factory = mod.SwarmPlugin ?? mod.default
        if (typeof factory !== "function") throw new Error("export SwarmPlugin introuvable")
        const plugin: any = await factory({ directory: dir, client: null, project: undefined })
        extraTools = plugin?.tool ?? {}
        diag(`extras: ${Object.keys(extraTools ?? {}).length} outils amont disponibles`)
      } catch (err) {
        extraLoadFailed = true
        diag(`extras indisponibles: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }
  await extraLoading
}

export default Plugin.define({
  id: "swarmaxe",

  async setup(ctx: any) {
    // setup() est appele une fois par projet ouvert (5 ici : Desktop, ~,
    // gmaps_leads, business, animated_landing) dans le meme processus. Un etat
    // au niveau du module serait ecrase par le dernier projet charge : chaque
    // jeu d'outils doit donc capturer SON repertoire.
    //
    // Le contexte d'outil V2, lui, n'expose aucun repertoire
    // (keys: sessionID, agent, messageID, id, progress, signal). Sans capture
    // ici, le repli process.cwd() donnait le dossier personnel pour tous les
    // projets : les cellules creees ailleurs devenaient introuvables a
    // la completion ("Bead not found").
    const projectDir: string = ctx?.location?.directory ?? ctx?.directory ?? process.cwd()
    diag(`setup(): projectDir=${projectDir}`)

    // Les outils V1 lancent le CLI `swarm` via spawn(). Le serveur OpenCode est
    // un processus de service demarre hors du shell interactif : Bun n'est donc
    // pas dans son PATH, et `#!/usr/bin/env bun` echoue. On l'enrichit une fois
    // ici ; tous les spawn() suivants en heriteront.
    const bunBin = join(homedir(), ".bun", "bin")
    if (bunBin && !process.env.PATH?.includes(bunBin)) {
      process.env.PATH = `${bunBin}:${process.env.PATH ?? ""}`
      diag(`setup(): PATH enrichi avec ${bunBin}`)
    }

    const hooks: any = await legacy({
      directory: projectDir,
      client: ctx.client,
      project: ctx.location.project,
    })

    const entries = Object.entries(hooks.tool ?? {}).filter(([name]) => name !== "skills_init") as [string, any][]
    const tools = entries.map(([name, t]) => adapt(name, t, projectDir))

    // Outils amont additionnels (lecture / diagnostic uniquement).
    await loadExtraTools(projectDir)
    if (extraTools) {
      let added = 0
      for (const name of EXTRA_TOOL_NAMES) {
        const t = extraTools[name]
        if (!t) continue
        try {
          tools.push(adapt(name, t, projectDir))
          added++
        } catch (err) {
          diag(`extras: ${name} ignore (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      diag(`extras: ${added} outils ajoutes`)
    }

    // Compatibilite : d'anciens prompts (dont celui du worker) demandent
    // `swarm_checkpoint`, absent du CLI 0.63.2. On l'expose et on le traduit
    // vers swarm_progress, pour qu'aucun agent ne se bloque sur un nom mort.
    // Le prompt genere passe `project_key="$PWD"` et `agent_name=...` : on
    // accepte ces champs et on remplace la valeur litterale par le vrai projet.
    tools.push({
      name: "swarm_checkpoint",
      description: "Record an in-progress checkpoint for a cell (compatibility alias for swarm_progress).",
      input: {
        type: "object",
        properties: {
          bead_id: { type: "string" },
          message: { type: "string" },
          project_key: { type: "string" },
          agent_name: { type: "string" },
        },
        required: ["bead_id"],
        additionalProperties: false,
      },
      async execute(rawArgs: any, ctx: any) {
        const dir = ctx?.directory ?? ctx?.location?.directory ?? projectDir
        const sessionID = ctx?.sessionID ?? ""
        const agent = agentNames.get(sessionID) ?? ctx?.agent ?? "swarm-worker"
        const rawKey = typeof rawArgs?.project_key === "string" ? rawArgs.project_key : ""
        const projectKey = !rawKey || rawKey === "$PWD" || rawKey === "${PWD}" ? dir : rawKey
        const payload = {
          project_key: projectKey,
          bead_id: rawArgs?.bead_id,
          status: "in_progress",
          message: rawArgs?.message ?? "checkpoint",
          agent_name: agent,
        }
        diag(`  swarm_checkpoint -> swarm_progress bead=${payload.bead_id}`)
        const text = await runSwarmCli("swarm_progress", payload, dir, sessionID, ctx?.messageID ?? "", agent)
        return { content: text }
      },
    })

    // Compatibilite : le prompt worker genere par le CLI appelle encore
    // `swarm_spawn_researcher`, qui n'existe plus. On expose l'outil et on
    // renvoie un brief pret a deleguer a l'agent swarm-researcher.
    tools.push({
      name: "swarm_spawn_researcher",
      description: "Build a research brief for the swarm-researcher subagent (compatibility tool; does not spawn by itself).",
      input: {
        type: "object",
        properties: {
          research_id: { type: "string" },
          epic_id: { type: "string" },
          tech_stack: { type: "array", items: { type: "string" } },
          project_path: { type: "string" },
        },
        required: ["tech_stack"],
        additionalProperties: false,
      },
      async execute(rawArgs: any, ctx: any) {
        const dir = ctx?.directory ?? ctx?.location?.directory ?? projectDir
        const rawPath = typeof rawArgs?.project_path === "string" ? rawArgs.project_path : ""
        const projectPath = !rawPath || rawPath === "$PWD" || rawPath === "${PWD}" ? dir : rawPath
        const tech = Array.isArray(rawArgs?.tech_stack) && rawArgs.tech_stack.length
          ? rawArgs.tech_stack.join(", ")
          : "the task"
        const prompt = [
          `Research ${tech} for the project at ${projectPath}.`,
          "1. Read package.json/lockfile to identify the exact installed versions.",
          "2. Fetch the official documentation for those versions.",
          "3. Summarize the API, breaking changes, and a minimal working example.",
          "4. Store the full findings with hivemind_store and return a 3-5 bullet summary.",
        ].join("\n")
        diag(`  swarm_spawn_researcher -> brief ${tech}`)
        return {
          content: JSON.stringify({
            success: true,
            research_id: rawArgs?.research_id ?? null,
            project_path: projectPath,
            prompt,
            message: "Research brief ready. Delegate it with subagent(agent=\"swarm-researcher\", description=\"Research: ...\", prompt=<prompt>).",
          }, null, 2),
        }
      },
    })

    // La porte de verification (tsc + tests) existe en amont mais n'est pas
    // exposee par le wrapper V1. On l'ajoute via le CLI (jamais in-process :
    // elle peut durer plusieurs minutes et bloquerait le service).
    tools.push({
      name: "swarm_verify",
      description:
        "Run the verification gate (typecheck + tests) for the given files, without completing the task. Heavy: routes through the swarm CLI (timeout 900s).",
      input: {
        type: "object",
        properties: {
          files_touched: { type: "array", items: { type: "string" }, description: "Files modified" },
          skip_verification: { type: "boolean", description: "Skip ALL verification (default false)" },
        },
        required: ["files_touched"],
      },
      async execute(rawArgs: any, ctx: any) {
        const dir2: string = ctx?.directory ?? projectDir
        diag(`  -> swarm_verify ${JSON.stringify(Object.keys(rawArgs ?? {}))}`)
        const text = await runSwarmCli(
          "swarm_verify",
          { ...(rawArgs ?? {}), project_key: dir2 },
          dir2,
          ctx?.sessionID ?? "",
          ctx?.messageID ?? "",
          ctx?.agent ?? "build",
        )
        return { content: text }
      },
    })

    // -------------------------------------------------------------------
    // SWARMAXE SKILL FORGE — gouvernance des skills.
    //
    // skill_forge  : valide puis ecrit un skill (frontmatter + sections
    //                imposees), verifie les scripts, refuse les secrets.
    //                commit:false = dry-run (defaut).
    // skill_curate : lit la memoire et propose des themes recurrents.
    // -------------------------------------------------------------------
    tools.push({
      name: "skill_forge",
      description:
        "Create a complete, validated OpenCode skill (SKILL.md + optional scripts) from a structured spec. Rejects catch-all skills, duplicates, secrets and scripts that do not parse. commit=false validates and renders only.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "kebab-case, 3-64 chars" },
          description: { type: "string", description: "20-200 chars, one line: when to use it" },
          when_to_use: { type: "string" },
          when_not_to_use: { type: "string", description: "Required: prevents catch-all skills" },
          steps: { type: "array", items: { type: "string" }, description: "At least 2 concrete steps" },
          verification: { type: "array", items: { type: "string" }, description: "At least 1 executable check" },
          pitfalls: { type: "array", items: { type: "string" } },
          references: { type: "array", items: { type: "string" } },
          scripts: {
            type: "array",
            description: "Files written under the skill's scripts/ directory",
            items: {
              type: "object",
              properties: { filename: { type: "string" }, content: { type: "string" } },
              required: ["filename", "content"],
            },
          },
          scope: { type: "string", enum: ["global", "project"], description: "global = ~/.config/opencode/skills" },
          overwrite: { type: "boolean" },
          commit: { type: "boolean", description: "false = dry-run (default)" },
        },
        required: ["name", "description", "when_to_use", "when_not_to_use", "steps", "verification"],
      },
      async execute(rawArgs: any, ctx: any) {
        const dir2: string = ctx?.directory ?? projectDir
        const scope: string = rawArgs?.scope === "project" ? "project" : "global"
        const root = skillRoot(scope, dir2)
        const { errors, warnings } = validateSkill(rawArgs ?? {}, root)
        const rendered = renderSkill(rawArgs ?? {})
        if (errors.length > 0) {
          return { content: JSON.stringify({ success: false, errors, warnings, preview: rendered.slice(0, 700) }, null, 2) }
        }
        if (rawArgs?.commit !== true) {
          return {
            content: JSON.stringify(
              { success: true, dry_run: true, target: join(root, String(rawArgs.name)), warnings, rendered },
              null,
              2,
            ),
          }
        }
        const skillDir = join(root, String(rawArgs.name))
        mkdirSync(skillDir, { recursive: true })
        const scripts: any[] = Array.isArray(rawArgs.scripts) ? rawArgs.scripts : []
        if (scripts.length > 0) {
          const scriptsDir = join(skillDir, "scripts")
          mkdirSync(scriptsDir, { recursive: true })
          for (const s of scripts) {
            const fp = join(scriptsDir, String(s.filename))
            writeFileSync(fp, String(s.content), "utf-8")
            if (String(s.filename).endsWith(".sh")) chmodSync(fp, 0o755)
          }
          const bad = syntaxCheck(scriptsDir, scripts)
          if (bad.length > 0) {
            return { content: JSON.stringify({ success: false, errors: bad, target: skillDir }, null, 2) }
          }
        }
        writeFileSync(join(skillDir, "SKILL.md"), rendered, "utf-8")
        let reload: any = null
        try {
          const t = extraTools?.["skills_reload"]
          if (t?.execute) {
            reload = String(
              await t.execute({}, { sessionID: ctx?.sessionID, messageID: ctx?.messageID, agent: ctx?.agent, directory: dir2 }),
            ).slice(0, 240)
          }
        } catch (e) {
          reload = String(e).slice(0, 160)
        }
        diag(`  skill_forge: ${rawArgs.name} -> ${skillDir}`)
        return {
          content: JSON.stringify(
            { success: true, target: skillDir, files: ["SKILL.md", ...scripts.map((s: any) => `scripts/${s.filename}`)], warnings, reload },
            null,
            2,
          ),
        }
      },
    })

    tools.push({
      name: "skill_curate",
      description:
        "Mine hivemind memories for recurring themes worth turning into skills. Returns ranked candidates with sample memory ids and a draft spec for skill_forge. Read-only.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Theme to explore (default: broad workflow query)" },
          limit: { type: "number", description: "Memories to analyse (default 60, max 200)" },
          min_occurrences: { type: "number", description: "Minimum tag frequency (default 2)" },
        },
      },
      async execute(rawArgs: any, ctx: any) {
        const dir2: string = ctx?.directory ?? projectDir
        const q = String(rawArgs?.query ?? "workflow procedure steps how to avoid pitfall")
        const limit = Math.min(Math.max(Number(rawArgs?.limit ?? 60), 10), 200)
        const minOcc = Math.max(Number(rawArgs?.min_occurrences ?? 2), 2)
        try {
          const finder: any = hooks?.tool?.hivemind_find
          const raw = finder?.execute
            ? await finder.execute(
                { query: q, limit },
                {
                  sessionID: ctx?.sessionID ?? "",
                  messageID: ctx?.messageID ?? "",
                  agent: ctx?.agent ?? "build",
                  directory: dir2,
                  worktree: dir2,
                  abort: ctx?.abort ?? new AbortController().signal,
                  metadata: () => {},
                  ask: async () => {},
                },
              )
            : "{}"
          const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw))
          const results: any[] = Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : []
          const counts = new Map<string, { n: number; ids: string[] }>()
          for (const r of results) {
            const tags: string[] = Array.isArray(r?.metadata?.tags) ? r.metadata.tags : []
            for (const t of tags) {
              const key = String(t).toLowerCase().slice(0, 40)
              if (!key || key.length < 3) continue
              const cur = counts.get(key) ?? { n: 0, ids: [] }
              cur.n += 1
              if (cur.ids.length < 3) cur.ids.push(String(r.id))
              counts.set(key, cur)
            }
          }
          const candidates = [...counts.entries()]
            .filter(([, v]) => v.n >= minOcc)
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, 8)
            .map(([tag, v]) => ({
              theme: tag,
              occurrences: v.n,
              sample_ids: v.ids,
              draft: {
                name: `${tag.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-playbook`.slice(0, 64),
                description: `Reusable playbook for ${tag} tasks, distilled from ${v.n} past runs.`.slice(0, 200),
                when_to_use: `A task involves ${tag}.`,
                when_not_to_use: `The task does not involve ${tag}, or the situation differs from the sampled runs.`,
                steps: [
                  "Read the sampled memories for the concrete commands.",
                  "Adapt the procedure to the current project layout.",
                  "Verify with the checks listed in those memories.",
                ],
                verification: ["At least one command from the sampled memories ran successfully in this project."],
                references: v.ids.map((id) => `memory:${id}`),
              },
            }))
          return {
            content: JSON.stringify(
              { query: q, analysed: results.length, candidates, hint: "Refine a draft, then call skill_forge with commit:false to validate it." },
              null,
              2,
            ),
          }
        } catch (e) {
          return { content: JSON.stringify({ error: String(e).slice(0, 200) }, null, 2) }
        }
      },
    })

    // Compatibilite : le `skills_init` du plugin V1 initialise un repertoire,
    // alors que celui du CLI 0.63.2 cree un modele de skill (arguments
    // incompatibles : name/directory au lieu de path). On conserve la
    // semantique V1 avec un outil dedie.
    tools.push({
      name: "skills_init",
      description: "Initialize the project skills directory (compatibility tool; default: .opencode/skill).",
      input: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(rawArgs: any, ctx: any) {
        const dir = ctx?.directory ?? ctx?.location?.directory ?? projectDir
        const rel = typeof rawArgs?.path === "string" && rawArgs.path.length ? rawArgs.path : ".opencode/skill"
        const target = rel.startsWith("/") ? rel : join(dir, rel)
        try {
          await mkdir(target, { recursive: true })
          diag(`  skills_init -> ${target}`)
          return {
            content: JSON.stringify({
              success: true,
              path: target,
              message: `Skills directory ready at ${target}`,
            }, null, 2),
          }
        } catch (err) {
          throw new Error(`skills_init: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    })

    // -------------------------------------------------------------------
    // MEMORY RETENTION
    //
    // Le modele d'embedding local (mxbai-embed-large) a un contexte de 512
    // tokens (~1 200 caracteres). Une entree plus longue etait envoyee telle
    // quelle et echouait avec "Failed to generate embedding" : le texte
    // n'etait alors stocke nulle part.
    //
    // Desormais : decoupage aux frontieres de phrases, une memoire par
    // morceau (liees par parent_id), et recherche hybride vectoriel + FTS
    // pour retrouver les memoires dont l'embedding est encore en attente.
    // -------------------------------------------------------------------
    const storeTool = tools.find((t: any) => t.name === "hivemind_store")
    if (storeTool && typeof storeTool.execute === "function") {
      const originalStore = storeTool.execute.bind(storeTool)
      storeTool.execute = async (rawArgs: any, tctx: any) => {
        const information = String(rawArgs?.information ?? "")
        const chunks = splitForEmbedding(information)
        if (chunks.length <= 1) {
          try {
            return await originalStore(rawArgs, tctx)
          } catch (err) {
            await new Promise((r) => setTimeout(r, 800))
            return await originalStore(rawArgs, tctx)
          }
        }
        const parent = newParentId()
        const ids: string[] = []
        const failures: string[] = []
        for (let i = 0; i < chunks.length; i++) {
          const partArgs = {
            ...rawArgs,
            information: chunks[i],
            metadata: mergeMetadata(rawArgs?.metadata, {
              parent_id: parent,
              part: i + 1,
              parts: chunks.length,
              chunk_chars: chunks[i].length,
              chunked: true,
            }),
            tags: [rawArgs?.tags, "chunked", `part:${i + 1}/${chunks.length}`]
              .filter(Boolean)
              .join(","),
          }
          let stored = false
          for (let attempt = 0; attempt < 2 && !stored; attempt++) {
            try {
              const res: any = await originalStore(partArgs, tctx)
              const raw = typeof res?.content === "string" ? res.content : JSON.stringify(res)
              const parsed = JSON.parse(raw)
              const id = parsed?.id ?? parsed?.data?.id ?? parsed?.memory?.id
              if (id) ids.push(String(id))
              stored = true
            } catch (err) {
              if (attempt === 1) {
                failures.push(`part ${i + 1}: ${String(err).slice(0, 140)}`)
              } else {
                await new Promise((r) => setTimeout(r, 700))
              }
            }
          }
        }
        diag(
          `  hivemind_store: ${information.length} car -> ${chunks.length} morceaux, ` +
            `${ids.length} stockes${failures.length ? `, ${failures.length} echecs` : ""}`,
        )
        return {
          content: JSON.stringify(
            {
              success: ids.length > 0,
              chunked: true,
              parent_id: parent,
              parts: chunks.length,
              ids,
              chars: information.length,
              failures,
              note:
                "Long memory split into parts (one embedding each). Group them with metadata.parent_id.",
            },
            null,
            2,
          ),
        }
      }
    }

    const findTool = tools.find((t: any) => t.name === "hivemind_find")
    if (findTool && typeof findTool.execute === "function") {
      const originalFind = findTool.execute.bind(findTool)
      findTool.execute = async (rawArgs: any, tctx: any) => {
        const primary: any = await originalFind(rawArgs, tctx)
        if (rawArgs?.fts === true) return primary
        const limit = Number(rawArgs?.limit ?? 10)
        try {
          const extra: any = await originalFind({ ...rawArgs, fts: true }, tctx)
          const a = JSON.parse(typeof primary?.content === "string" ? primary.content : "{}")
          const b = JSON.parse(typeof extra?.content === "string" ? extra.content : "{}")
          const merged = mergeFindResults(a, b, Number.isFinite(limit) ? limit : 10)
          if (merged) return { content: JSON.stringify(merged) }
        } catch {
          // FTS est un filet : son echec ne doit pas casser la recherche vectorielle.
        }
        return primary
      }
    }

    diag(`setup(): ${tools.length} outils a enregistrer`)

    let refused = 0
    await ctx.tool.transform((editor: any) => {
      for (const t of tools) {
        try {
          editor.add(t)
        } catch (err) {
          refused++
          diag(`  REFUS ${t.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })
    diag(`setup(): ${tools.length} proposes, ${refused} refuses explicitement`)

    // --- Hook de compaction -------------------------------------------------
    const compactV1 = hooks["experimental.session.compacting"]
    let compactReg: any

    if (typeof compactV1 === "function") {
      compactReg = await ctx.session.hook("compaction", async (event: any) => {
        const out: any = { context: [] as string[], prompt: undefined as string | undefined }
        try {
          await compactV1({ sessionID: event.sessionID }, out)
        } catch (err) {
          diag(`  hook compaction echoue: ${err}`)
          return
        }
        // V1 poussait du contexte ; V2 expose `result` pour remplacer le resume.
        const text = out.prompt ?? (out.context?.length ? out.context.join("\n\n") : "")
        if (text) event.result = { summary: text }
      })
      diag("setup(): hook compaction enregistre")
    }

    // Le registre est reconcilie apres coup : on relit l'etat reel.
    const active = (await ctx.tool.list()).map((t: any) => String(t.id))
    const activeIds = new Set(active)
    const missing = tools.map((t) => t.name).filter((n) => !activeIds.has(n))
    diag(
      `setup(): ${tools.length - missing.length}/${tools.length} outils swarmaxe actifs` +
        (missing.length ? ` | manquants: ${missing.join(", ")}` : ""),
    )

    return () => {
      // toolReg dispose par le runtime au dechargement
      compactReg?.dispose()
    }
  },
})