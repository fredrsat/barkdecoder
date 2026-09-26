import { SAMPLE_RATE, rms } from './audio'

export interface AcousticFeatures {
  /** Median grunnfrekvens i Hz, eller null hvis ingen tonal lyd ble funnet */
  pitchHz: number | null
  /** Varighet i sekunder */
  durationSec: number
  /** Antall separate lydutbrudd (f.eks. enkeltbjeff) */
  burstCount: number
  /** Utbrudd per sekund — høy verdi betyr intens, rask bjeffing */
  burstRate: number
}

/**
 * Grunnfrekvens via autokorrelasjon på en 25 ms-ramme.
 * Returnerer null hvis rammen ikke er tydelig periodisk.
 */
function framePitch(frame: Float32Array): number | null {
  const minHz = 150
  const maxHz = 1500
  const minLag = Math.floor(SAMPLE_RATE / maxHz)
  const maxLag = Math.floor(SAMPLE_RATE / minHz)
  if (frame.length < maxLag + 1) return null

  let energy = 0
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i]
  if (energy < 1e-6) return null

  let bestLag = 0
  let bestCorr = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < frame.length - lag; i++) corr += frame[i] * frame[i + lag]
    corr /= energy
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }
  if (bestCorr < 0.5 || bestLag === 0) return null
  return SAMPLE_RATE / bestLag
}

export function extractFeatures(samples: Float32Array): AcousticFeatures {
  const durationSec = samples.length / SAMPLE_RATE

  // Tonehøyde: median over rammer med tydelig periodisitet
  const frameLen = Math.floor(0.025 * SAMPLE_RATE)
  const hop = Math.floor(0.010 * SAMPLE_RATE)
  const overallRms = rms(samples)
  const pitches: number[] = []
  for (let start = 0; start + frameLen <= samples.length; start += hop) {
    const frame = samples.subarray(start, start + frameLen)
    if (rms(frame) < overallRms * 0.5) continue // hopp over stille partier
    const p = framePitch(frame)
    if (p !== null) pitches.push(p)
  }
  pitches.sort((a, b) => a - b)
  const pitchHz = pitches.length >= 3 ? pitches[Math.floor(pitches.length / 2)] : null

  // Utbrudd: tell overganger fra stille til lyd i RMS-konvolutten
  const envHop = Math.floor(0.020 * SAMPLE_RATE)
  const envelope: number[] = []
  for (let start = 0; start + envHop <= samples.length; start += envHop) {
    envelope.push(rms(samples.subarray(start, start + envHop)))
  }
  const peak = Math.max(...envelope, 1e-9)
  const onThreshold = peak * 0.35
  const offThreshold = peak * 0.15
  let burstCount = 0
  let active = false
  for (const level of envelope) {
    if (!active && level > onThreshold) {
      active = true
      burstCount++
    } else if (active && level < offThreshold) {
      active = false
    }
  }

  return {
    pitchHz,
    durationSec,
    burstCount,
    burstRate: durationSec > 0 ? burstCount / durationSec : 0,
  }
}
