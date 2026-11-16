#!/usr/bin/env bun
/**
 * swarmaxe-reembed.ts — reprise des memoires dont l'embedding a echoue.
 *
 * Le modele local a un contexte de 512 tokens (~1 200 caracteres). Une entree
 * plus longue peut echouer ou produire un vecteur de mauvaise qualite. Ce
 * script recalcule le vecteur par morceaux (moyenne normalisee), sans jamais
 * toucher au contenu ni changer l'identifiant.
 *
 * La base utilise un index vectoriel libSQL (`libsql_vector_idx`) : les
 * ecritures passent donc par @libsql/client, pas par sqlite3.
 *
 *   bun swarmaxe-reembed.ts --dry-run
 *   bun swarmaxe-reembed.ts --null-only --limit 5
 *   bun swarmaxe-reembed.ts --over-budget
 *   bun swarmaxe-reembed.ts --all
 */
import { execSync } from "node:child_process"
import { homedir, loadavg } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PKG = process.env.SWARM_PKG_ROOT || join(execSync("npm root -g", { encoding: "utf8" }).trim(), "opencode-swarm-plugin")
const DB_PATH = process.env.SWARM_DB || join(homedir(), ".config", "swarm-tools", "swarm.db")
const HOST = process.env.OLLAMA_HOST || "http://localhost:11434"
const MODEL = process.env.OLLAMA_MODEL || "mxbai-embed-large"
const NUM_CTX = Number(process.env.SWARMAXE_EMBED_NUM_CTX || 512)
const MAX_CHARS = Number(process.env.SWARMAXE_EMBED_MAX_CHARS || 1200)
const OVERLAP = Number(process.env.SWARMAXE_EMBED_CHUNK_OVERLAP || 150)

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const limitArg = args.indexOf("--limit")
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1] || 0) : 0
const loadArg = args.indexOf("--max-load")
const MAX_LOAD = loadArg >= 0 ? Number(args[loadArg + 1] || 0) : 0
const DRY = has("--dry-run")
const DO_NULL = has("--null-only") || has("--all") || (!has("--over-budget") && !has("--all"))
const DO_LONG = has("--over-budget") || has("--all")

export function splitForEmbedding(text: string, max = MAX_CHARS, overlap = OVERLAP): string[] {
  const input = String(text ?? "")
  if (!input) return []
  if (input.length <= max) return [input]
  const chunks: string[] = []
  let start = 0
  while (start < input.length) {
    let end = Math.min(start + max, input.length)
    if (end < input.length) {
      const w = input.slice(start, end)
      const cuts = [
        w.lastIndexOf("\n\n"),
        w.lastIndexOf("\n"),
        w.lastIndexOf(". "),
        w.lastIndexOf("; "),
        w.lastIndexOf("! "),
        w.lastIndexOf("? "),
        w.lastIndexOf(", "),
      ].filter((i) => i > max * 0.5)
      if (cuts.length) end = start + Math.max(...cuts) + 1
    }
    const chunk = input.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= input.length) break
    const next = end - Math.min(overlap, Math.floor(max / 3))
    start = next > start ? next : end
  }
  return chunks
}

async function embed(text: string, attempts = 3): Promise<number[] | null> {
  let delay = 1000
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${HOST}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: text, options: { num_ctx: NUM_CTX } }),
        signal: AbortSignal.timeout(180_000),
      })
      if (res.ok) {
        const data: any = await res.json()
        const vec = data?.embeddings?.[0] ?? data?.embedding
        if (Array.isArray(vec) && vec.length) return vec.map(Number)
      }
    } catch {
      // retry
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, delay))
      delay *= 2
    }
  }
  return null
}

function average(vecs: number[][]): number[] {
  const out = new Array(vecs[0].length).fill(0)
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i]
  for (let i = 0; i < out.length; i++) out[i] /= vecs.length
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1
  return out.map((x) => x / norm)
}

const where: string[] = []
const sqlArgs: any[] = []
if (DO_NULL) where.push("embedding IS NULL")
if (DO_LONG) {
  where.push("length(content) > ?")
  sqlArgs.push(MAX_CHARS)
}
let sql =
  "SELECT id, content, metadata, length(embedding) AS emb_len FROM memories " +
  `WHERE ${where.length ? where.map((w) => `(${w})`).join(" OR ") : "0"} ` +
  "ORDER BY updated_at DESC"
if (LIMIT) {
  sql += " LIMIT ?"
  sqlArgs.push(LIMIT)
}

const clientMod: any = await import(
  pathToFileURL(join(PKG, "node_modules", "@libsql", "client", "lib-esm", "node.js")).href
)
const load = loadavg()[0]
if (MAX_LOAD > 0 && load > MAX_LOAD) {
  console.log(`charge systeme ${load.toFixed(1)} > ${MAX_LOAD} : reprise reportee (relancer plus tard)`)
  process.exit(0)
}
const db = clientMod.createClient({ url: `file:${DB_PATH}` })
await db.execute("PRAGMA busy_timeout = 15000")

const rows = (await db.execute({ sql, args: sqlArgs })).rows as any[]
console.log(`${rows.length} memoire(s) a traiter (budget ${MAX_CHARS} car., modele ${MODEL}, num_ctx ${NUM_CTX})`)
if (DRY) {
  for (const r of rows.slice(0, 20)) console.log(`  ${r.id}  ${String(r.content).length} car.  embedding=${r.emb_len}`)
  process.exit(0)
}

let done = 0
let failed = 0
let skipped = 0
const started = Date.now()

for (let idx = 0; idx < rows.length; idx++) {
  const row = rows[idx]
  const content = String(row.content ?? "")
  const chunks = splitForEmbedding(content)
  if (!chunks.length) {
    skipped++
    continue
  }
  const vecs: number[][] = []
  let ok = true
  for (const chunk of chunks) {
    const v = await embed(chunk)
    if (!v) {
      ok = false
      break
    }
    vecs.push(v)
  }
  if (!ok) {
    failed++
    console.log(`  FAIL ${row.id} (${content.length} car.)`, )
    continue
  }
  const vec = vecs.length > 1 ? average(vecs) : vecs[0]
  let meta: Record<string, any> = {}
  try {
    meta = row.metadata ? JSON.parse(String(row.metadata)) : {}
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {}
  } catch {
    meta = {}
  }
  meta.embedding_status = "ok"
  meta.reembedded_at = new Date().toISOString()
  meta.embedding_parts = chunks.length

  await db.execute({
    sql: "UPDATE memories SET embedding = vector(?), metadata = ?, updated_at = datetime('now') WHERE id = ?",
    args: [JSON.stringify(vec), JSON.stringify(meta), String(row.id)],
  })
  done++
  if ((idx + 1) % 10 === 0 || idx + 1 === rows.length) {
    const rate = (Date.now() - started) / (idx + 1) / 1000
    const remain = (rate * (rows.length - idx - 1)) / 60
    console.log(
      `  ${idx + 1}/${rows.length}  ok=${done} fail=${failed} skip=${skipped}  ` +
        `${rate.toFixed(1)}s/memoire  reste ~${remain.toFixed(0)} min`,
    )
  }
}

console.log(`termine: ok=${done} fail=${failed} skip=${skipped}`)
process.exit(failed === 0 ? 0 : 1)
