import type { StoredExample } from './db'

export interface Prediction {
  label: string
  /** Andel av den vektede stemmegivningen, 0–1 */
  confidence: number
}

/** Minst så mange eksempler per etikett før den personlige modellen brukes */
export const MIN_EXAMPLES_PER_LABEL = 3

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-9)
}

export function labelCounts(examples: StoredExample[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of examples) counts.set(e.label, (counts.get(e.label) ?? 0) + 1)
  return counts
}

/** Etiketter med nok eksempler til å telle med i klassifiseringen */
export function activeLabels(examples: StoredExample[]): string[] {
  return [...labelCounts(examples)]
    .filter(([, n]) => n >= MIN_EXAMPLES_PER_LABEL)
    .map(([label]) => label)
}

/**
 * kNN med cosinuslikhet over YAMNet-embeddings.
 * Returnerer null hvis ingen etikett har nok eksempler ennå.
 */
export function classify(embedding: Float32Array, examples: StoredExample[], k = 5): Prediction | null {
  const usable = new Set(activeLabels(examples))
  if (usable.size === 0) return null
  const candidates = examples.filter((e) => usable.has(e.label))

  const neighbors = candidates
    .map((e) => ({ label: e.label, sim: cosineSimilarity(embedding, e.embedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)

  const votes = new Map<string, number>()
  let totalWeight = 0
  for (const n of neighbors) {
    const weight = Math.max(0, n.sim)
    votes.set(n.label, (votes.get(n.label) ?? 0) + weight)
    totalWeight += weight
  }
  if (totalWeight <= 0) return null

  let bestLabel = ''
  let bestWeight = 0
  for (const [label, weight] of votes) {
    if (weight > bestWeight) {
      bestWeight = weight
      bestLabel = label
    }
  }
  return { label: bestLabel, confidence: bestWeight / totalWeight }
}
