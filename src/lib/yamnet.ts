import * as tf from '@tensorflow/tfjs'

export interface YamnetResult {
  /** Gjennomsnittlige klasse-scorer over alle rammer, lengde 521 */
  scores: Float32Array
  /** Gjennomsnittlig embedding over alle rammer, lengde 1024 */
  embedding: Float32Array
}

const MIN_SAMPLES = 15600 // YAMNet trenger minst én ramme på 0,975 s ved 16 kHz

let model: tf.GraphModel | null = null
let classNames: string[] = []
let loadPromise: Promise<void> | null = null

export function loadYamnet(): Promise<void> {
  if (!loadPromise) loadPromise = doLoad()
  return loadPromise
}

async function doLoad(): Promise<void> {
  const [loaded, csv] = await Promise.all([
    tf.loadGraphModel('models/yamnet/model.json'),
    fetch('models/yamnet_class_map.csv').then((r) => r.text()),
  ])
  model = loaded
  classNames = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      // format: index,mid,display_name (display_name kan være i anførselstegn)
      const m = line.match(/^\d+,[^,]+,"?(.*?)"?$/)
      return m ? m[1] : ''
    })
}

export function getClassNames(): string[] {
  return classNames
}

export async function analyze(waveform: Float32Array): Promise<YamnetResult> {
  if (!model) throw new Error('YAMNet er ikke lastet')
  let input = waveform
  if (input.length < MIN_SAMPLES) {
    const padded = new Float32Array(MIN_SAMPLES)
    padded.set(input)
    input = padded
  }
  const result = tf.tidy(() => {
    const wave = tf.tensor1d(input)
    const outputs = model!.execute(wave) as tf.Tensor[]
    let scores: tf.Tensor | null = null
    let embeddings: tf.Tensor | null = null
    for (const t of outputs) {
      const lastDim = t.shape[t.shape.length - 1]
      if (lastDim === 521) scores = t
      else if (lastDim === 1024) embeddings = t
    }
    if (!scores || !embeddings) throw new Error('Uventede YAMNet-utganger')
    return {
      scores: scores.mean(0),
      embedding: embeddings.mean(0),
    }
  })
  const [scores, embedding] = await Promise.all([
    result.scores.data() as Promise<Float32Array>,
    result.embedding.data() as Promise<Float32Array>,
  ])
  result.scores.dispose()
  result.embedding.dispose()
  return { scores, embedding }
}

// Hunderelaterte klasser i AudioSet, gruppert i norske kategorier
export type DogCategory = 'bjeff' | 'knurring' | 'uling' | 'piping' | 'hund'

const CATEGORY_CLASSES: Record<DogCategory, string[]> = {
  bjeff: ['Bark', 'Bow-wow', 'Yip'],
  knurring: ['Growling'],
  uling: ['Howl'],
  piping: ['Whimper (dog)', 'Whimper'],
  hund: ['Dog', 'Canidae, dogs, wolves'],
}

export interface DogScores {
  /** Samlet sannynlighet for at dette er hundelyd */
  total: number
  /** Beste kategori blant de spesifikke lydtypene */
  category: DogCategory
  perCategory: Record<DogCategory, number>
}

export function dogScores(scores: Float32Array): DogScores {
  const perCategory = {} as Record<DogCategory, number>
  for (const [cat, names] of Object.entries(CATEGORY_CLASSES)) {
    let s = 0
    for (const name of names) {
      const idx = classNames.indexOf(name)
      if (idx >= 0) s = Math.max(s, scores[idx])
    }
    perCategory[cat as DogCategory] = s
  }
  const specific: DogCategory[] = ['bjeff', 'knurring', 'uling', 'piping']
  let category: DogCategory = 'hund'
  let best = 0
  for (const cat of specific) {
    if (perCategory[cat] > best) {
      best = perCategory[cat]
      category = cat
    }
  }
  const total = Math.max(perCategory.hund, best)
  return { total, category, perCategory }
}

export function topClasses(scores: Float32Array, n = 5): { name: string; score: number }[] {
  return Array.from(scores)
    .map((score, i) => ({ name: classNames[i], score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}
