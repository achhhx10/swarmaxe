/**
 * Memoire hivemind — budget d'embedding et decoupage.
 *
 * Le modele local (mxbai-embed-large) a un contexte de 512 tokens, soit
 * ~1 200 caracteres de texte FR/EN. Une entree plus longue est decoupee en
 * morceaux qui tiennent dans ce contexte : chaque morceau est embedde
 * correctement, et le contenu complet reste stocke (aucune perte).
 *
 * SWARMAXE_EMBED_MAX_CHARS permet d'ajuster le budget si le modele change.
 */

export const DEFAULT_EMBED_MAX_CHARS = 1200
export const DEFAULT_CHUNK_OVERLAP = 150

export function embedMaxChars(): number {
  const raw = Number(process.env.SWARMAXE_EMBED_MAX_CHARS)
  if (Number.isFinite(raw) && raw >= 200 && raw <= 100_000) return Math.floor(raw)
  return DEFAULT_EMBED_MAX_CHARS
}

/**
 * Decoupe un texte en morceaux <= max, en coupant de preference sur une
 * frontiere de paragraphe, de ligne ou de phrase. Les morceaux se recouvrent
 * de `overlap` caracteres pour ne pas perdre le contexte a la jointure.
 */
export function splitForEmbedding(
  text: string,
  max: number = embedMaxChars(),
  overlap: number = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const input = String(text ?? "")
  if (!input) return []
  if (input.length <= max) return [input]

  const chunks: string[] = []
  let start = 0
  let guard = 0

  while (start < input.length && guard++ < 10_000) {
    let end = Math.min(start + max, input.length)
    if (end < input.length) {
      const window = input.slice(start, end)
      const candidates = [
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("; "),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
        window.lastIndexOf(", "),
      ].filter((i) => i > max * 0.5)
      if (candidates.length) end = start + Math.max(...candidates) + 1
    }
    const chunk = input.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= input.length) break
    const next = end - Math.max(0, Math.min(overlap, Math.floor(max / 3)))
    start = next > start ? next : end
  }

  return chunks
}

/** Identifiant de groupe pour les morceaux d'une meme memoire. */
export function newParentId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `memgrp-${Date.now().toString(36)}-${rand}`
}

/** Fusionne un metadata JSON (chaine ou objet) avec des champs supplementaires. */
export function mergeMetadata(raw: unknown, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {}
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed
    } catch {
      // metadata invalide : on la remplace par un objet propre
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    base = { ...(raw as Record<string, unknown>) }
  }
  return JSON.stringify({ ...base, ...patch })
}

/**
 * Fusionne deux jeux de resultats hivemind (vectoriel puis FTS) : les hits
 * vectoriels gardent leur ordre, les hits FTS absents sont ajoutes a la fin.
 * Retourne null si le format n'est pas reconnu.
 */
export function mergeFindResults(primary: any, extra: any, limit: number): any | null {
  const a = Array.isArray(primary?.results) ? primary.results : null
  const b = Array.isArray(extra?.results) ? extra.results : null
  if (!a || !b) return null
  const seen = new Set(a.map((r: any) => String(r?.id ?? r?.memory?.id ?? "")))
  const merged = [...a]
  for (const r of b) {
    const id = String(r?.id ?? r?.memory?.id ?? "")
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push({ ...r, matchType: r?.matchType ?? "fts" })
    if (merged.length >= limit) break
  }
  return { ...primary, results: merged.slice(0, Math.max(limit, a.length)) }
}
