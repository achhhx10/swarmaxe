#!/usr/bin/env bun
/**
 * swarmaxe-memory-import.ts — importe les memoires des autres machines.
 *
 * Lit <sync-dir>/<autre-host>.jsonl, ignore les ids deja presents et les
 * contenus identiques (sha256), insere le reste avec un vecteur NULL.
 * Lancer ensuite swarmaxe-reembed.ts --null-only pour vectoriser.
 *
 *   bun swarmaxe-memory-import.ts --dry-run
 *   bun swarmaxe-memory-import.ts --dir ~/SwarmSync
 */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PKG = process.env.SWARM_PKG_ROOT || join(execSync("npm root -g", { encoding: "utf8" }).trim(), "opencode-swarm-plugin")
const DB_PATH = process.env.SWARM_DB || join(homedir(), ".config", "swarm-tools", "swarm.db")
const args = process.argv.slice(2)
const dirArg = args.indexOf("--dir")
const DIR = dirArg >= 0 ? args[dirArg + 1] : process.env.SWARM_SYNC_DIR || join(homedir(), "SwarmSync")
const DRY = args.includes("--dry-run")

const self = hostname()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 40)

const clientMod: any = await import(
  pathToFileURL(join(PKG, "node_modules", "@libsql", "client", "lib-esm", "node.js")).href
)
const db = clientMod.createClient({ url: `file:${DB_PATH}` })
await db.execute("PRAGMA busy_timeout = 15000")

const existing = (await db.execute("SELECT id, content FROM memories")).rows as any[]
const ids = new Set(existing.map((r) => String(r.id)))
const hashes = new Set(existing.map((r) => createHash("sha256").update(String(r.content ?? "").trim()).digest("hex")))

let files: string[] = []
try {
  files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl") && f !== `${self}.jsonl`)
} catch {
  console.log(`dossier de sync introuvable: ${DIR}`)
  process.exit(0)
}

let created = 0
let skippedId = 0
let skippedHash = 0
let invalid = 0

for (const file of files) {
  const source = file.replace(/\.jsonl$/, "")
  const lines = readFileSync(join(DIR, file), "utf8").split("\n")
  for (const line of lines) {
    const raw = line.trim()
    if (!raw) continue
    let entry: any
    try {
      entry = JSON.parse(raw)
    } catch {
      invalid++
      continue
    }
    const id = String(entry.id ?? "")
    const content = String(entry.information ?? entry.content ?? "")
    if (!id || !content) {
      invalid++
      continue
    }
    if (ids.has(id)) {
      skippedId++
      continue
    }
    const hash = createHash("sha256").update(content.trim()).digest("hex")
    if (hashes.has(hash)) {
      skippedHash++
      continue
    }

    let metadata: Record<string, unknown> = {}
    try {
      metadata = entry.metadata ? JSON.parse(entry.metadata) : {}
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {}
    } catch {
      metadata = { raw_metadata: entry.metadata }
    }
    metadata.embedding_status = "pending"
    metadata.imported_from = source
    metadata.imported_at = new Date().toISOString()

    const tags = typeof entry.tags === "string" ? entry.tags : JSON.stringify(entry.tags ?? [])
    const createdAt = typeof entry.created_at === "string" && entry.created_at ? entry.created_at : new Date().toISOString()

    if (DRY) {
      created++
      continue
    }

    await db.execute({
      sql: "INSERT INTO memories (id, content, metadata, collection, tags, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      args: [id, content, JSON.stringify(metadata), String(entry.collection ?? "default"), tags, createdAt],
    })
    ids.add(id)
    hashes.add(hash)
    created++
  }
}

console.log(
  `import${DRY ? " (dry-run)" : ""}: ${created} nouvelles, ${skippedId} deja presentes, ` +
    `${skippedHash} contenus identiques, ${invalid} lignes invalides (${files.length} fichier(s))`,
)
if (created > 0 && !DRY) {
  console.log("etape suivante: bun swarmaxe-reembed.ts --null-only --max-load 6")
}
process.exit(0)
