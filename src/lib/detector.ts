import { MicCapture, SAMPLE_RATE, rms } from './audio'
import { analyze, dogScores, type DogCategory, type DogScores } from './yamnet'
import { extractFeatures, type AcousticFeatures } from './features'

export const SESSION_SECONDS = 30

export interface LiveStatus {
  state: 'stille' | 'lyd' | 'hundelyd'
  category: DogCategory | null
  dogScore: number
}

export interface SessionResult {
  id: string
  timestamp: number
  /** Dominerende lydtype i økten */
  category: DogCategory
  /** Tydelig innslag av en annen lydtype, hvis noen */
  secondaryCategory: DogCategory | null
  dogScore: number
  /** Sammenveide akustiske trekk for hele økten */
  features: AcousticFeatures
  /** Varighetsvektet gjennomsnitts-embedding, til den personlige modellen */
  embedding: Float32Array
  /** Hundelyd-sekvensene i økten, limt sammen */
  clip: Float32Array
  segmentCount: number
  /** Sekunder med faktisk hundelyd i økten */
  activeSec: number
}

interface SegmentAnalysis {
  dog: DogScores
  embedding: Float32Array
  features: AcousticFeatures
  clip: Float32Array
  durationSec: number
}

const WINDOW = Math.floor(0.96 * SAMPLE_RATE)
const HOP_MS = 480
const NOISE_GATE = 0.008
const DOG_THRESHOLD = 0.2
const SEGMENT_END_SILENCE_MS = 1200
const MAX_SEGMENT_SEC = 8
const PRE_ROLL = Math.floor(0.3 * SAMPLE_RATE)
const MAX_CLIP_SEC = 20

/**
 * Én lytteøkt: lytter i SESSION_SECONDS (eller til stopEarly), finner
 * hundelyd-sekvensene underveis og sammenfatter dem til én helhetsvurdering.
 */
export class ListeningSession {
  private mic = new MicCapture()
  private timer: number | null = null
  private busy = false
  private segmentStart: number | null = null
  private lastDogTime = 0
  private endTime = 0
  private segments: SegmentAnalysis[] = []
  private finishing = false

  onStatus: ((status: LiveStatus) => void) | null = null
  onTick: ((secondsLeft: number) => void) | null = null
  onLevel: ((rmsLevel: number) => void) | null = null
  /** Kalles én gang når økten er ferdig; null hvis ingen hundelyd ble fanget */
  onDone: ((result: SessionResult | null) => void) | null = null

  async start() {
    this.mic.onLevel = (level) => this.onLevel?.(level)
    await this.mic.start()
    this.endTime = Date.now() + SESSION_SECONDS * 1000
    this.timer = window.setInterval(() => void this.tick(), HOP_MS)
  }

  stopEarly() {
    void this.finish()
  }

  private async tick() {
    if (this.busy || this.finishing) return
    this.busy = true
    try {
      const now = Date.now()
      this.onTick?.(Math.max(0, Math.ceil((this.endTime - now) / 1000)))
      if (now >= this.endTime) {
        await this.finish()
        return
      }
      await this.step(now)
    } catch (err) {
      console.error('Øktfeil:', err)
    } finally {
      this.busy = false
    }
  }

  private async step(now: number) {
    const ring = this.mic.ring
    const window = ring.last(WINDOW)
    if (window.length < WINDOW) return

    const level = rms(window)
    if (level < NOISE_GATE && this.segmentStart === null) {
      this.onStatus?.({ state: 'stille', category: null, dogScore: 0 })
      return
    }

    const { scores } = await analyze(window)
    const dog = dogScores(scores)
    const isDog = dog.total >= DOG_THRESHOLD

    if (isDog) {
      this.lastDogTime = now
      if (this.segmentStart === null) {
        this.segmentStart = Math.max(0, ring.total - window.length - PRE_ROLL)
      }
      this.onStatus?.({ state: 'hundelyd', category: dog.category, dogScore: dog.total })
    } else {
      this.onStatus?.({
        state: level < NOISE_GATE ? 'stille' : 'lyd',
        category: null,
        dogScore: dog.total,
      })
    }

    if (this.segmentStart !== null) {
      const segLenSec = (ring.total - this.segmentStart) / SAMPLE_RATE
      const silentLongEnough = !isDog && now - this.lastDogTime > SEGMENT_END_SILENCE_MS
      if (silentLongEnough || segLenSec > MAX_SEGMENT_SEC) {
        await this.closeSegment()
      }
    }
  }

  /** Analyser og arkiver sekvensen som nettopp ble avsluttet */
  private async closeSegment() {
    if (this.segmentStart === null) return
    const clip = this.mic.ring.since(this.segmentStart)
    this.segmentStart = null
    if (clip.length === 0) return
    const { scores, embedding } = await analyze(clip)
    this.segments.push({
      dog: dogScores(scores),
      embedding,
      features: extractFeatures(clip),
      clip,
      durationSec: clip.length / SAMPLE_RATE,
    })
  }

  private async finish() {
    if (this.finishing) return
    this.finishing = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    try {
      await this.closeSegment()
    } catch (err) {
      console.error('Øktfeil ved avslutning:', err)
    }
    this.mic.stop()
    this.onDone?.(this.aggregate())
  }

  /** Vei delhendelsene sammen til én helhetsvurdering, vektet på varighet */
  private aggregate(): SessionResult | null {
    const segs = this.segments
    if (segs.length === 0) return null

    const totalDur = segs.reduce((s, x) => s + x.durationSec, 0)
    const w = (seg: SegmentAnalysis) => seg.durationSec / totalDur

    const categories: DogCategory[] = ['bjeff', 'knurring', 'uling', 'piping', 'hund']
    const perCategory = {} as Record<DogCategory, number>
    for (const cat of categories) {
      perCategory[cat] = segs.reduce((s, seg) => s + w(seg) * seg.dog.perCategory[cat], 0)
    }
    const specific = categories.filter((c) => c !== 'hund')
    const ranked = specific.sort((a, b) => perCategory[b] - perCategory[a])
    const category: DogCategory = perCategory[ranked[0]] > 0.05 ? ranked[0] : 'hund'
    const secondaryCategory =
      category !== 'hund' && perCategory[ranked[1]] > 0.12 ? ranked[1] : null

    const embedding = new Float32Array(1024)
    for (const seg of segs) {
      const weight = w(seg)
      for (let i = 0; i < 1024; i++) embedding[i] += weight * seg.embedding[i]
    }

    const pitched = segs.filter((s) => s.features.pitchHz !== null)
    const pitchHz = pitched.length
      ? pitched.reduce((s, x) => s + x.features.pitchHz! * x.durationSec, 0) /
        pitched.reduce((s, x) => s + x.durationSec, 0)
      : null
    const burstCount = segs.reduce((s, x) => s + x.features.burstCount, 0)

    const maxClipSamples = MAX_CLIP_SEC * SAMPLE_RATE
    const clipLen = Math.min(maxClipSamples, segs.reduce((s, x) => s + x.clip.length, 0))
    const clip = new Float32Array(clipLen)
    let pos = 0
    for (const seg of segs) {
      const room = clipLen - pos
      if (room <= 0) break
      clip.set(room >= seg.clip.length ? seg.clip : seg.clip.subarray(0, room), pos)
      pos += Math.min(room, seg.clip.length)
    }

    return {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      category,
      secondaryCategory,
      dogScore: segs.reduce((s, x) => s + w(x) * x.dog.total, 0),
      features: {
        pitchHz,
        durationSec: totalDur,
        burstCount,
        burstRate: totalDur > 0 ? burstCount / totalDur : 0,
      },
      embedding,
      clip,
      segmentCount: segs.length,
      activeSec: totalDur,
    }
  }
}
