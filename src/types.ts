export interface Word {
  text: string
  /** character offset into the sentence text */
  start: number
  end: number
}

export interface Sentence {
  /** position in the flat sentence list */
  index: number
  text: string
  words: Word[]
}

export type WorkerRequest =
  | { type: 'init'; device: 'webgpu' | 'wasm' }
  | { type: 'synthesize'; id: number; text: string; voice: string; speed: number }
  | { type: 'cancel' }

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'ready'; device: string }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id?: number; message: string }
