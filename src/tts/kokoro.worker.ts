import { KokoroTTS } from 'kokoro-js'
import { env as hfEnv } from '@huggingface/transformers'
import type { WorkerRequest, WorkerResponse } from '../types'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? [])

// surface crashes with a real message instead of a dead worker
self.addEventListener('error', (e) =>
  post({ type: 'error', message: `worker crashed: ${e.message || e.filename || 'unknown error'}` }),
)
self.addEventListener('unhandledrejection', (e) =>
  post({ type: 'error', message: `worker crashed: ${(e as PromiseRejectionEvent).reason}` }),
)

let tts: KokoroTTS | null = null
let busy = false
const queue: Extract<WorkerRequest, { type: 'synthesize' }>[] = []

function load(device: 'webgpu' | 'wasm') {
  return KokoroTTS.from_pretrained(MODEL_ID, {
    // q8 is broken on WebGPU in transformers.js, so fp32 there; q8 keeps the WASM download small
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    device,
    progress_callback: (p) => {
      if (p.status === 'progress') {
        post({ type: 'progress', loaded: p.loaded ?? 0, total: p.total ?? 0, file: p.file ?? '' })
      }
    },
  })
}

async function init(device: 'webgpu' | 'wasm', threads?: number) {
  // multithreaded WASM crashes on some browsers — the client can retry
  // with threads pinned to 1
  if (threads && hfEnv.backends.onnx.wasm) hfEnv.backends.onnx.wasm.numThreads = threads
  // no in-worker fallback: a failed WebGPU init leaves onnxruntime in a broken
  // state, so the client recreates the whole worker and retries with WASM
  tts = await load(device)
  post({ type: 'ready', device: threads === 1 ? `${device} (1 thread)` : device })
  pump()
}

async function pump() {
  if (busy || !tts) return
  const req = queue.shift()
  if (!req) return
  busy = true
  try {
    const audio = await tts.generate(req.text, {
      voice: req.voice as keyof KokoroTTS['voices'],
      speed: req.speed,
    })
    const samples = audio.audio
    post(
      { type: 'audio', id: req.id, samples, sampleRate: audio.sampling_rate },
      [samples.buffer as ArrayBuffer],
    )
  } catch (e) {
    post({ type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) })
  } finally {
    busy = false
    pump()
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'init') {
    init(msg.device, msg.threads).catch((err) =>
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
  } else if (msg.type === 'synthesize') {
    queue.push(msg)
    pump()
  } else if (msg.type === 'cancel') {
    queue.length = 0
  }
}
