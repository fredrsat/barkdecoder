import { MicCapture, SAMPLE_RATE, rms } from './audio'
import { analyze, dogScores, type DogCategory } from './yamnet'
import { extractFeatures, type AcousticFeatures } from './features'

export interface DogEvent {
  id: string
  timestamp: number
  category: DogCategory
  dogScore: number
  perCategory: Record<DogCategory, number>
  features: AcousticFeatures
  embedding: Float32Array
  /** Lydklippet ved 16 kHz, inkl. litt før og etter */
  clip: Float32Array
}

export interface LiveStatus {
  state: 'stille' | 'lyd' | 'hundelyd'
  /** Hva som høres akkurat nå, hvis hundelyd */
  category: DogCategory | null
  dogScore: number
}

const WINDOW = Math.floor(0.96 * SAMPLE_RATE)
const HOP_MS = 480
const NOISE_GATE = 0.008
const DOG_THRESHOLD = 0.2
const EVENT_END_SILENCE_MS = 1200
const MAX_EVENT_SEC = 8
const PRE_ROLL = Math.floor(0.3 * SAMPLE_RATE)

export class DogDetector {
  private mic = new MicCapture()
  private timer: number | null = null
  private busy = false
  private eventStart: number | null = null // absolutt sampelposisjon
  private lastDogTime = 0
  private eventPeakScore = 0

  onStatus: ((status: LiveStatus) => void) | null = null
  onEvent: ((event: DogEvent) => void) | null = null
  onLevel: ((rmsLevel: number) => void) | null = null

  async start() {
    this.mic.onLevel = (level) => this.onLevel?.(level)
    await this.mic.start()
    this.timer = window.setInterval(() => void this.tick(), HOP_MS)
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.mic.stop()
    this.eventStart = null
  }

  private async tick() {
    if (this.busy) return
    this.busy = true
    try {
      await this.step()
    } catch (err) {
      console.error('Detektorfeil:', err)
    } finally {
      this.busy = false
    }
  }

  private async step() {
    const ring = this.mic.ring
    const window = ring.last(WINDOW)
    if (window.length < WINDOW) return

    const now = Date.now()
    const level = rms(window)

    // Under støyterskelen og ingen aktiv hendelse: ikke kjør modellen
    if (level < NOISE_GATE && this.eventStart === null) {
      this.onStatus?.({ state: 'stille', category: null, dogScore: 0 })
      return
    }

    const { scores } = await analyze(window)
    const dog = dogScores(scores)
    const isDog = dog.total >= DOG_THRESHOLD

    if (isDog) {
      this.lastDogTime = now
      this.eventPeakScore = Math.max(this.eventPeakScore, dog.total)
      if (this.eventStart === null) {
        this.eventStart = Math.max(0, ring.total - window.length - PRE_ROLL)
      }
      this.onStatus?.({ state: 'hundelyd', category: dog.category, dogScore: dog.total })
    } else {
      this.onStatus?.({
        state: level < NOISE_GATE ? 'stille' : 'lyd',
        category: null,
        dogScore: dog.total,
      })
    }

    // Avslutt hendelsen etter en stille periode, eller ved maks lengde
    if (this.eventStart !== null) {
      const eventLenSec = (ring.total - this.eventStart) / SAMPLE_RATE
      const silentLongEnough = !isDog && now - this.lastDogTime > EVENT_END_SILENCE_MS
      if (silentLongEnough || eventLenSec > MAX_EVENT_SEC) {
        const clip = ring.since(this.eventStart)
        this.eventStart = null
        const peak = this.eventPeakScore
        this.eventPeakScore = 0
        await this.finishEvent(clip, peak)
      }
    }
  }

  private async finishEvent(clip: Float32Array, peakScore: number) {
    const { scores, embedding } = await analyze(clip)
    const dog = dogScores(scores)
    const event: DogEvent = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      category: dog.category,
      dogScore: Math.max(dog.total, peakScore),
      perCategory: dog.perCategory,
      features: extractFeatures(clip),
      embedding,
      clip,
    }
    this.onEvent?.(event)
  }
}
