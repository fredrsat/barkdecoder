export const SAMPLE_RATE = 16000

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0].slice(0))
    }
    return true
  }
}
registerProcessor('capture-processor', CaptureProcessor)
`

/** Enkel lineær nedsampling til 16 kHz */
function resample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input
  const ratio = fromRate / SAMPLE_RATE
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** Rullende buffer med de siste `seconds` sekundene lyd ved 16 kHz */
export class RingBuffer {
  private buffer: Float32Array
  private writePos = 0
  /** Totalt antall sampler skrevet siden start */
  total = 0

  constructor(seconds: number) {
    this.buffer = new Float32Array(seconds * SAMPLE_RATE)
  }

  append(chunk: Float32Array) {
    for (let i = 0; i < chunk.length; i++) {
      this.buffer[this.writePos] = chunk[i]
      this.writePos = (this.writePos + 1) % this.buffer.length
    }
    this.total += chunk.length
  }

  /** Hent de siste n samplene (eller færre hvis mindre er skrevet) */
  last(n: number): Float32Array {
    const available = Math.min(n, this.total, this.buffer.length)
    const out = new Float32Array(available)
    let pos = (this.writePos - available + this.buffer.length * 2) % this.buffer.length
    for (let i = 0; i < available; i++) {
      out[i] = this.buffer[pos]
      pos = (pos + 1) % this.buffer.length
    }
    return out
  }

  /** Hent sampler fra absolutt posisjon `from` (i total-sampler) til nå */
  since(from: number): Float32Array {
    const n = Math.max(0, this.total - from)
    return this.last(n)
  }
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  readonly ring = new RingBuffer(12)
  /** Kalles for hvert lydstykke, med RMS-nivå for meteret */
  onLevel: ((rms: number) => void) | null = null

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Nettleseren støtter ikke mikrofonopptak')
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    // Bruk maskinvarens samplerate og resample selv til 16 kHz — Safari nekter
    // å koble mikrofonstrømmen til en kontekst med avvikende samplerate.
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)

    const source = ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(ctx, 'capture-processor')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const chunk = resample(e.data, ctx.sampleRate)
      this.ring.append(chunk)
      if (this.onLevel) {
        let sum = 0
        for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
        this.onLevel(Math.sqrt(sum / chunk.length))
      }
    }
    source.connect(this.node)
    // Ikke koblet til destination — vi vil ikke spille av mikrofonen
  }

  stop() {
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.ctx?.close()
    this.ctx = null
  }
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}
