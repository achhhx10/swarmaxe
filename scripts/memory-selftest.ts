#!/usr/bin/env bun
/**
 * memory-selftest.ts — verifie le chemin memoire reellement utilise par le
 * plugin : SwarmPlugin (dist/index.js) -> hivemind_store.
 *
 * Le bug d'origine : ce chemin passait par swarm-mail non patche
 * (/api/embeddings, contexte 512) et toute memoire > ~1 800 caracteres
 * echouait avec "Failed to generate embedding" — le texte etait perdu.
 *
 * Ici : ~2 500 caracteres, recherche semantique, puis suppression.
 * Sortie : "MEMORY-SELFTEST OK ..." ou "MEMORY-SELFTEST FAIL ...".
 */
import { execSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const root = execSync("npm root -g", { encoding: "utf8" }).trim()
const entry = `${root}/opencode-swarm-plugin/dist/index.js`

const unique = `selftest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const long = (
  `Memoire de test ${unique}. La retention doit fonctionner meme pour une entree longue. ` +
  "Le pipeline decoupe le texte en morceaux qui tiennent dans le contexte du modele, " +
  "chaque morceau recoit son propre vecteur, et le contenu complet reste interrogeable. "
).repeat(8).slice(0, 2500)

const ctx: any = {
  sessionID: "memory-selftest",
  messageID: "",
  agent: "build",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata() {},
  ask: async () => {},
}

let createdId: string | null = null

try {
  const mod: any = await import(pathToFileURL(entry).href)
  const factory = mod.SwarmPlugin ?? mod.default
  const plugin: any = await factory({ directory: process.cwd(), client: null, project: undefined })
  const store = plugin?.tool?.hivemind_store
  const find = plugin?.tool?.hivemind_find
  const remove = plugin?.tool?.hivemind_remove
  if (!store || !find) throw new Error("hivemind tools not exposed by SwarmPlugin")

  const storedRaw: any = await store.execute(
    {
      information: long,
      collection: "default",
      tags: "selftest,memory-retention",
      metadata: JSON.stringify({ selftest: true, marker: unique }),
    },
    ctx,
  )
  const storedText = typeof storedRaw === "string" ? storedRaw : JSON.stringify(storedRaw)
  const stored = JSON.parse(storedText)
  createdId = stored?.id ?? stored?.data?.id ?? null
  if (!createdId) throw new Error(`store returned no id: ${storedText.slice(0, 200)}`)

  const foundRaw: any = await find.execute({ query: long, limit: 10 }, ctx)
  const foundText = typeof foundRaw === "string" ? foundRaw : JSON.stringify(foundRaw)
  const found = JSON.parse(foundText)
  const ids = (found?.results ?? []).map((r: any) => String(r?.id ?? r?.memory?.id ?? ""))
  let hit = ids.includes(String(createdId))
  if (!hit) {
    // le vecteur est une moyenne de morceaux : on elargit avant de conclure
    const wideRaw: any = await find.execute({ query: long, limit: 50 }, ctx)
    const wide = JSON.parse(typeof wideRaw === "string" ? wideRaw : JSON.stringify(wideRaw))
    hit = (wide?.results ?? []).some((r: any) => String(r?.id ?? r?.memory?.id ?? "") === String(createdId))
  }

  if (remove && createdId) await remove.execute({ id: createdId }, ctx)
  createdId = null

  if (!hit) throw new Error(`stored memory ${stored.id} not found by semantic search`)
  console.log(`MEMORY-SELFTEST OK (${long.length} chars, id=${stored.id})`)
  process.exit(0)
} catch (err) {
  if (createdId) {
    try {
      const mod: any = await import(pathToFileURL(entry).href)
      const factory = mod.SwarmPlugin ?? mod.default
      const plugin: any = await factory({ directory: process.cwd(), client: null, project: undefined })
      await plugin?.tool?.hivemind_remove?.execute({ id: createdId }, ctx)
    } catch {}
  }
  console.error(`MEMORY-SELFTEST FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
