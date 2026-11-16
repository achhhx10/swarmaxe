#!/usr/bin/env bun
/**
 * swarmaxe-memory-export.ts — exporte les memoires locales sans vecteurs.
 *
 * Un fichier par machine : <sync-dir>/<hostname>.jsonl. Chaque Mac n'ecrit
 * que le sien, donc deux exports simultanes ne se ecrasent jamais.
 *
 * Les embeddings ne sont pas exportes : ils dependent du modele local et sont
 * recalculés a l'import par swarmaxe-reembed.ts.
 *
 *   bun swarmaxe-memory-export.ts
 *   bun swarmaxe-memory-export.ts --dir ~/SwarmSync
 */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PKG = process.env.SWARM_PKG_ROOT || join(execSync("npm root -g", { encoding: "utf8" }).trim(), "opencode-swarm-plugin")
const DB_PATH = process.env.SWARM_DB || join(homedir(), ".config", "swarm-tools", "swarm.db")
const args = process.argv.slice(2)
const dirArg = args.indexOf("--dir")
const DIR = dirArg >= 0 ? args[dirArg + 1] : process.env.SWARM_SYNC_DIR || join(homedir(), "SwarmSync")

const host = hostname()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 40)

const clientMod: any = await import(
  pathToFileURL(join(PKG, "node_modules", "@libsql", "client", "lib-esm", "node.js")).href
)
const db = clientMod.createClient({ url: `file:${DB_PATH}` })
await db.execute("PRAGMA busy_timeout = 15000")

const rows = (
  await db.execute(
    "SELECT id, content, collection, tags, metadata, created_at, decay_factor FROM memories ORDER BY created_at ASC",
  )
).rows as any[]

const lines: string[] = []
for (const row of rows) {
  const content = String(row.content ?? "")
  const entry: Record<string, unknown> = {
    id: String(row.id),
    information: content,
    collection: String(row.collection ?? "default"),
    created_at: String(row.created_at ?? ""),
    content_sha256: createHash("sha256").update(content.trim()).digest("hex"),
  }
  if (row.tags) entry.tags = String(row.tags)
  if (row.metadata) entry.metadata = typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata)
  if (row.decay_factor !== null && row.decay_factor !== undefined) entry.confidence = Number(row.decay_factor)
  lines.push(JSON.stringify(entry))
}

mkdirSync(DIR, { recursive: true })
const target = join(DIR, `${host}.jsonl`)
const tmp = `${target}.tmp`
writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", "utf8")
renameSync(tmp, target)

console.log(`export ${host}: ${lines.length} memoires -> ${target}`)
process.exit(0)
