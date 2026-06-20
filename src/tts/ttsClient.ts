import type { WorkerRequest, WorkerResponse } from '../types'
import { isMobileDevice } from '../lib/platform'

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

/** User-selectable performance presets for the Kokoro engine. */
export type Perf = 'auto' | 'cores' | 'lite' | 'lite-cores'

export const PERF_OPTIONS: { id: Perf; label: string }[] = [
  { id: 'auto', label: 'Default' },
  { id: 'cores', label: 'All CPU cores' },
  { id: 'lite', label: 'Lite model' },
  { id: 'lite-cores', label: 'Lite + all cores' },
]

export interface InitOpts {
  /** model variant to try first (always on WASM — quantized dtypes are unreliable on WebGPU) */
  dtype?: string
  /** WASM thread count (the runtime's default caps at 4) */
  threads?: number
}

export function perfToOpts(perf: Perf): InitOpts {
  const threads = navigator.hardwareConcurrency || 4
  switch (perf) {
    case 'cores':
      return { threads }
    case 'lite':
      return { dtype: 'q4' }
    case 'lite-cores':
      return { dtype: 'q4', threads }
    default:
      return {}
  }
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
  init(onProgress: (p: ProgressInfo) => void, opts: InitOpts = {}): Promise<string> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      const device = await pickDevice()
      // fallback ladder: a failed attempt leaves the worker unusable, so each
      // retry starts a fresh worker. threads:1 covers browsers where
      // multithreaded WASM (SharedArrayBuffer) crashes.
      const mobile = isMobileDevice()
      const attempts: { device: 'webgpu' | 'wasm'; threads?: number; dtype?: string }[] =
        mobile
          ? [
              // Phones are usually memory-bound and mobile WebGPU is still
              // uneven for ONNX. Prefer the smallest WASM model and one
              // thread; users who want to experiment can still override via
              // query params or the performance picker.
              { device: 'wasm', dtype: opts.dtype ?? 'q4', threads: opts.threads ?? 1 },
              { device: 'wasm', dtype: 'q8', threads: 1 },
            ]
          : device === 'webgpu'
            ? [{ device: 'webgpu' }, { device: 'wasm' }, { device: 'wasm', threads: 1 }]
            : [{ device: 'wasm' }, { device: 'wasm', threads: 1 }]
      // performance preset: a lite-model attempt goes in front of the ladder,
      // a thread count applies to WASM attempts that don't pin their own
      // (the threads:1 crash-retry keeps its 1)
      if (opts.dtype && !mobile) attempts.unshift({ device: 'wasm', dtype: opts.dtype })
      if (opts.threads) {
        for (const a of attempts) if (a.device === 'wasm' && a.threads == null) a.threads = opts.threads
      }
      // testing hooks: ?dtype=fp16 etc. tries that variant first;
      // ?threads=8 overrides the WASM thread count (default caps at 4)
      const params = new URLSearchParams(location.search)
      const dtypeOverride = params.get('dtype')
      if (dtypeOverride) attempts.unshift({ device, dtype: dtypeOverride })
      const threadsOverride = Number(params.get('threads'))
      if (threadsOverride > 0) {
        for (const a of attempts) if (a.device === 'wasm') a.threads = threadsOverride
      }
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
