import type { WorkerRequest, WorkerResponse } from '../types'

export interface SynthResult {
  samples: Float32Array
  sampleRate: number
}

export interface ProgressInfo {
  loaded: number
  total: number
  file: string
}

export class CancelledError extends Error {
  constructor() {
    super('synthesis cancelled')
    this.name = 'CancelledError'
  }
}

interface Pending {
  resolve: (r: SynthResult) => void
  reject: (e: Error) => void
}

export async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  if (new URLSearchParams(location.search).get('device') === 'wasm') return 'wasm'
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return 'wasm'
  try {
    // navigator.gpu can exist with no usable adapter (headless, some Linux setups)
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

export class TtsClient {
  private worker = this.startWorker()
  private pending = new Map<number, Pending>()
  private nextId = 1
  private initPromise: Promise<string> | null = null

  private startWorker(): Worker {
    return new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' })
  }

  private send(msg: WorkerRequest) {
    this.worker.postMessage(msg)
  }

  /** Loads the model (idempotent). Resolves with the device actually used. */
  init(onProgress: (p: ProgressInfo) => void): Promise<string> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      const device = await pickDevice()
      // fallback ladder: a failed attempt leaves the worker unusable, so each
      // retry starts a fresh worker. threads:1 covers browsers where
      // multithreaded WASM (SharedArrayBuffer) crashes.
      const attempts: { device: 'webgpu' | 'wasm'; threads?: number; dtype?: string }[] =
        device === 'webgpu'
          ? [{ device: 'webgpu' }, { device: 'wasm' }, { device: 'wasm', threads: 1 }]
          : [{ device: 'wasm' }, { device: 'wasm', threads: 1 }]
      // testing hook: ?dtype=fp16 etc. tries that variant first
      const dtypeOverride = new URLSearchParams(location.search).get('dtype')
      if (dtypeOverride) attempts.unshift({ device, dtype: dtypeOverride })
      let lastError: unknown
      for (const attempt of attempts) {
        try {
          return await this.initWith(attempt.device, onProgress, attempt.threads, attempt.dtype)
        } catch (e) {
          lastError = e
          console.warn('TTS init failed for', attempt, e)
          this.worker.terminate()
          this.worker = this.startWorker()
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    })()
    return this.initPromise
  }

  /** Terminate the worker; the client is unusable afterwards. */
  dispose() {
    this.worker.terminate()
  }

  private initWith(
    device: 'webgpu' | 'wasm',
    onProgress: (p: ProgressInfo) => void,
    threads?: number,
    dtype?: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data
        switch (msg.type) {
          case 'progress':
            onProgress(msg)
            break
          case 'ready':
            resolve(msg.device)
            break
          case 'audio': {
            const p = this.pending.get(msg.id)
            if (p) {
              this.pending.delete(msg.id)
              p.resolve({ samples: msg.samples, sampleRate: msg.sampleRate })
            }
            break
          }
          case 'error':
            if (msg.id != null) {
              const p = this.pending.get(msg.id)
              if (p) {
                this.pending.delete(msg.id)
                p.reject(new Error(msg.message))
              }
            } else {
              reject(new Error(msg.message))
            }
            break
        }
      }
      this.worker.onerror = (e) =>
        reject(new Error(e.message || `TTS worker failed to start (${e.filename || 'no details'})`))
      this.send({ type: 'init', device, threads, dtype })
    })
  }

  synthesize(text: string, voice: string, speed: number): Promise<SynthResult> {
    const id = this.nextId++
    return new Promise<SynthResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ type: 'synthesize', id, text, voice, speed })
    })
  }

  /** Flush the worker queue and reject everything in flight. */
  cancelAll() {
    this.send({ type: 'cancel' })
    const ps = [...this.pending.values()]
    this.pending.clear()
    for (const p of ps) p.reject(new CancelledError())
  }
}
