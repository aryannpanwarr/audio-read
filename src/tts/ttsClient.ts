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
      try {
        return await this.initWith(device, onProgress)
      } catch (e) {
        if (device !== 'webgpu') throw e
        // a failed WebGPU init leaves the worker unusable — start fresh on WASM
        console.warn('WebGPU init failed, retrying with WASM in a fresh worker:', e)
        this.worker.terminate()
        this.worker = this.startWorker()
        return await this.initWith('wasm', onProgress)
      }
    })()
    return this.initPromise
  }

  private initWith(device: 'webgpu' | 'wasm', onProgress: (p: ProgressInfo) => void): Promise<string> {
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
      this.worker.onerror = (e) => reject(new Error(e.message || 'TTS worker crashed'))
      this.send({ type: 'init', device })
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
