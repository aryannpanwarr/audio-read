/**
 * Thin Web Audio wrapper: plays one AudioBuffer at a time and exposes a
 * sample-accurate position clock for the word highlighter.
 * Pause/resume = AudioContext suspend/resume, which freezes the clock too.
 */
export class Player {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private startTime = 0
  private duration = 0

  private ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  /** Call from a user-gesture handler — autoplay policy requires it. */
  unlock() {
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
  }

  makeBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
    const ctx = this.ensureContext()
    const buf = ctx.createBuffer(1, samples.length, sampleRate)
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    return buf
  }

  play(buffer: AudioBuffer, onEnded: () => void) {
    const ctx = this.ensureContext()
    this.stop()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    this.source = src
    this.startTime = ctx.currentTime
    this.duration = buffer.duration
    src.onended = () => {
      if (this.source === src) {
        this.source = null
        onEnded()
      }
    }
    src.start()
  }

  stop() {
    if (this.source) {
      const src = this.source
      this.source = null // makes the onended guard fail
      src.onended = null
      try {
        src.stop()
      } catch {
        // already stopped
      }
    }
  }

  pause() {
    void this.ctx?.suspend()
  }

  resume() {
    void this.ctx?.resume()
  }

  get hasSource(): boolean {
    return this.source !== null
  }

  /** Seconds into the currently playing sentence. */
  get elapsed(): number {
    if (!this.ctx || !this.source) return 0
    return Math.min(this.ctx.currentTime - this.startTime, this.duration)
  }

  get currentDuration(): number {
    return this.source ? this.duration : 0
  }
}
