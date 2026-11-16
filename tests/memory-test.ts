/**
 * memory-test.ts — tests hors ligne du decoupage memoire (aucun reseau).
 * Verifie que les morceaux tiennent dans le budget du modele d'embedding.
 */
import { splitForEmbedding, mergeMetadata, mergeFindResults, embedMaxChars } from "../src/lib/memory.ts"

let failed = 0
const check = (name: string, cond: boolean) => {
  if (!cond) {
    console.error(`FAIL ${name}`)
    failed++
  }
}

const budget = embedMaxChars()
check("budget par defaut 1200", budget === 1200)

const short = "x".repeat(500)
check("court: un seul morceau", splitForEmbedding(short, budget).length === 1)

const long = "La memoire doit rester fiable. ".repeat(120).slice(0, 3200)
const chunks = splitForEmbedding(long, budget, 150)
check("long: plusieurs morceaux", chunks.length >= 3)
check("long: chaque morceau <= budget", chunks.every((c) => c.length <= budget))
check("long: contenu conserve (debut)", chunks[0].startsWith("La memoire"))
check("long: contenu conserve (fin)", chunks[chunks.length - 1] === long.slice(-chunks[chunks.length - 1].length).trim())
check("long: pas de morceau vide", chunks.every((c) => c.length > 0))

const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraphe ${i} : ` + "detail ".repeat(30)).join("\n\n")
const paraChunks = splitForEmbedding(paragraphs, budget, 150)
check("paragraphes: coupe sur les frontieres", paraChunks.length >= 2 && paraChunks.every((c) => c.length <= budget))
check("paragraphes: aucun contenu perdu", paraChunks.join("").includes("Paragraphe 19"))

const meta = mergeMetadata('{"a":1}', { parent_id: "p", part: 1 })
const parsed = JSON.parse(meta)
check("metadata: fusion", parsed.a === 1 && parsed.parent_id === "p" && parsed.part === 1)
check("metadata: JSON invalide tolere", JSON.parse(mergeMetadata("not-json", { x: 2 })).x === 2)

const merged = mergeFindResults(
  { results: [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }] },
  { results: [{ id: "b", score: 0.7 }, { id: "c", score: 0.6 }] },
  10,
)
check("find: dedoublonne", merged?.results.filter((r: any) => r.id === "b").length === 1)
check("find: ajoute les hits FTS", merged?.results.some((r: any) => r.id === "c"))
check("find: limite respectee", mergeFindResults({ results: [{ id: "a" }] }, { results: [{ id: "b" }] }, 1)?.results.length === 1)

if (failed) {
  console.error(`MEMORY-TEST FAIL (${failed})`)
  process.exit(1)
}
console.log("MEMORY-TEST OK")
