import { useEffect, useRef, useState } from 'react'
import type { Sentence } from '../types'
import { extractParagraphs, NoTextError } from '../lib/pdf'
import { chunkBoundaries, rangeWeight, segmentParagraphs, sentenceWeight, wordIndexInRange } from '../lib/segment'
import { docKey, loadPosition, loadPrefs, savePosition, savePrefs } from '../lib/persist'
import { TimeEstimator } from '../lib/estimate'
import { TtsClient, CancelledError, type ProgressInfo } from '../tts/ttsClient'
import { DEFAULT_VOICE } from '../tts/voices'
import { cancelSpeech, hasDeviceTts, loadDeviceVoices, speak } from '../tts/deviceTts'
import { Player } from '../audio/player'

export type Phase = 'idle' | 'extracting' | 'ready' | 'playing' | 'paused' | 'buffering'
export type ModelStatus = 'idle' | 'loading' | 'ready'
export type Engine = 'kokoro' | 'device'

export interface Highlight {
  s: number
  w: number
}

const PREFETCH_MIN = 3
const PREFETCH_MAX = 8
const CACHE_LIMIT = 24

interface AudioChunk {
  buf: AudioBuffer
  /** word range [fromWord, toWord) of the sentence this chunk speaks */
  fromWord: number
  toWord: number
}

interface SentenceAudio {
  chunks: AudioChunk[]
  complete: boolean
}

function initialEngine(): Engine {
  const saved = localStorage.getItem('audio-read-engine')
  if (saved === 'kokoro' || saved === 'device') {
    return saved === 'device' && !hasDeviceTts() ? 'kokoro' : saved
  }
  // phones: native OS voices are instant and need no 90MB download
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  return mobile && hasDeviceTts() ? 'device' : 'kokoro'
}

export function useReader() {
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [sentences, setSentences] = useState<Sentence[]>([])
  const [current, setCurrent] = useState(0)
  const [highlight, setHighlight] = useState<Highlight | null>(null)
  const [voice, setVoiceState] = useState(() => loadPrefs().voice ?? DEFAULT_VOICE)
  const [speed, setSpeedState] = useState(() => loadPrefs().speed ?? 1)
  const [engine, setEngineState] = useState<Engine>(initialEngine)
  const [deviceVoices, setDeviceVoices] = useState<SpeechSynthesisVoice[]>([])
  const [deviceVoiceUri, setDeviceVoiceUriState] = useState<string>('')
  const [modelStatus, setModelStatusState] = useState<ModelStatus>('idle')
  const [modelProgress, setModelProgress] = useState({ loaded: 0, total: 0 })
  const [device, setDevice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [times, setTimes] = useState({ total: 0, remaining: 0 })

  const phaseRef = useRef<Phase>('idle')
  const sentencesRef = useRef<Sentence[]>([])
  const prefixRef = useRef<number[]>([0]) // prefix[i] = total weight of sentences 0..i-1
  const currentRef = useRef(0)
  const docKeyRef = useRef<string | null>(null)
  const voiceRef = useRef(voice)
  const speedRef = useRef(speed)
  const engineRef = useRef<Engine>(engine)
  const deviceVoicesRef = useRef<SpeechSynthesisVoice[]>([])
  const deviceVoiceUriRef = useRef('')
  const deviceTokenRef = useRef(0) // invalidates stale utterance callbacks
  const modelStatusRef = useRef<ModelStatus>('idle')
  const epochRef = useRef(0)
  const waitingForRef = useRef<{ s: number; chunk: number } | null>(null)
  const playingChunkRef = useRef<{ s: number; chunk: number } | null>(null)
  const cacheRef = useRef(new Map<number, SentenceAudio>())
  const pendingRef = useRef(new Set<number>())
  const failedRef = useRef(new Set<number>())
  const ttsRef = useRef<TtsClient | null>(null)
  const playerRef = useRef(new Player())
  const estimatorRef = useRef(new TimeEstimator())
  const progressFilesRef = useRef(new Map<string, ProgressInfo>())
  const prefetchAheadRef = useRef(PREFETCH_MIN)
  const gapCountRef = useRef(0)

  const setPhase = (p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }

  const setModelStatus = (s: ModelStatus) => {
    modelStatusRef.current = s
    setModelStatusState(s)
  }

  const setCurrentSentence = (i: number) => {
    currentRef.current = i
    setCurrent(i)
    if (docKeyRef.current && sentencesRef.current.length > 0) {
      savePosition(docKeyRef.current, i)
    }
  }

  // ---------- kokoro engine ----------

  /**
   * Synthesize sentence i in clause-sized pieces. The first piece is small,
   * so audio can start (sub-)seconds after a cold start; all pieces are
   * posted to the worker queue up front, so prefetch for later sentences
   * can never delay this sentence's remainder.
   */
  const synthesizeSentence = async (i: number, epoch: number) => {
    const sents = sentencesRef.current
    const cache = cacheRef.current
    if (i >= sents.length || cache.get(i)?.complete || pendingRef.current.has(i) || failedRef.current.has(i)) return
    if (!ttsRef.current || modelStatusRef.current !== 'ready') return
    const s = sents[i]
    const n = s.words.length
    pendingRef.current.add(i)
    try {
      const bounds = chunkBoundaries(s)
      const pieces = bounds.map((from, idx) => {
        const to = idx + 1 < bounds.length ? bounds[idx + 1] : n
        const endChar = to < n ? s.words[to].start : s.text.length
        return { text: s.text.slice(s.words[from].start, endChar).trim(), from, to }
      })
      // enqueue everything now — the worker is serial, results come in order
      const requests = pieces.map((p) =>
        ttsRef.current!.synthesize(p.text, voiceRef.current, speedRef.current),
      )
      for (const r of requests) r.catch(() => {}) // late cancellations are expected

      const entry: SentenceAudio = { chunks: [], complete: false }
      for (let idx = 0; idx < pieces.length; idx++) {
        const { samples, sampleRate } = await requests[idx]
        if (epoch !== epochRef.current) return
        const piece = pieces[idx]
        const buf = playerRef.current.makeBuffer(samples, sampleRate)
        estimatorRef.current.observe(rangeWeight(s, piece.from, piece.to), buf.duration, speedRef.current)
        entry.chunks.push({ buf, fromWord: piece.from, toWord: piece.to })
        entry.complete = piece.to === n
        cache.set(i, entry) // re-set in case eviction raced us
        const waiting = waitingForRef.current
        if (waiting && waiting.s === i && waiting.chunk < entry.chunks.length) {
          waitingForRef.current = null
          playChunk(i, waiting.chunk)
        }
      }
      evictCache()
    } catch (e) {
      if (e instanceof CancelledError || epoch !== epochRef.current) return
      console.error(`Synthesis failed for sentence ${i}:`, e)
      cache.delete(i) // drop any partial head
      failedRef.current.add(i)
      if (waitingForRef.current?.s === i) {
        waitingForRef.current = null
        startSentence(i + 1)
      }
    } finally {
      pendingRef.current.delete(i)
    }
  }

  const evictCache = () => {
    const cache = cacheRef.current
    if (cache.size <= CACHE_LIMIT) return
    const cur = currentRef.current
    const keys = [...cache.keys()].sort((a, b) => Math.abs(b - cur) - Math.abs(a - cur))
    for (const k of keys) {
      if (cache.size <= CACHE_LIMIT - 4) break
      if (k === cur) continue
      cache.delete(k)
    }
  }

  const prefetchFrom = (from: number) => {
    const epoch = epochRef.current
    for (let i = from; i < Math.min(from + prefetchAheadRef.current, sentencesRef.current.length); i++) {
      void synthesizeSentence(i, epoch)
    }
  }

  /** Playback outran synthesis: deepen the runway, and after repeated
   * underruns tell the user this device can't keep up in real time. */
  const registerGap = () => {
    prefetchAheadRef.current = Math.min(PREFETCH_MAX, prefetchAheadRef.current + 2)
    gapCountRef.current++
    if (gapCountRef.current === 3 && engineRef.current === 'kokoro') {
      setHint(
        'Your device generates AI audio slower than it plays. For gap-free listening, switch the Engine to “Device”, or enable WebGPU in your browser (chrome://flags → “Unsafe WebGPU”).',
      )
    }
  }

  /** Play chunk c of sentence i, chaining into the next chunk/sentence. */
  const playChunk = (i: number, c: number) => {
    const entry = cacheRef.current.get(i)
    const chunk = entry?.chunks[c]
    if (!chunk) {
      setPhase('buffering')
      waitingForRef.current = { s: i, chunk: c }
      return
    }
    playingChunkRef.current = { s: i, chunk: c }
    setPhase('playing')
    playerRef.current.play(chunk.buf, () => {
      const e = cacheRef.current.get(i)
      if (e && c + 1 < e.chunks.length) {
        playChunk(i, c + 1)
      } else if (e && !e.complete) {
        registerGap()
        setPhase('buffering')
        waitingForRef.current = { s: i, chunk: c + 1 }
      } else {
        startSentence(i + 1, true)
      }
    })
  }

  // ---------- device (Web Speech) engine ----------

  const startDeviceSentence = (i: number) => {
    const sents = sentencesRef.current
    if (i >= sents.length) {
      setPhase('ready')
      setHighlight(null)
      setCurrentSentence(0)
      return
    }
    const s = sents[i]
    setCurrentSentence(i)
    setHighlight({ s: i, w: 0 })
    setPhase('playing')
    const token = ++deviceTokenRef.current
    const voiceObj =
      deviceVoicesRef.current.find((v) => v.voiceURI === deviceVoiceUriRef.current) ?? null
    const t0 = performance.now()
    speak(s.text, voiceObj, speedRef.current, {
      onBoundary: (charIndex) => {
        if (token !== deviceTokenRef.current) return
        let w = 0
        for (let k = 0; k < s.words.length; k++) {
          if (s.words[k].start <= charIndex) w = k
          else break
        }
        setHighlight((prev) => (prev && prev.s === i && prev.w === w ? prev : { s: i, w }))
      },
      onEnd: () => {
        if (token !== deviceTokenRef.current) return
        estimatorRef.current.observe(sentenceWeight(s), (performance.now() - t0) / 1000, speedRef.current)
        startDeviceSentence(i + 1)
      },
      onError: (err) => {
        if (token !== deviceTokenRef.current) return
        console.error(`Device speech failed for sentence ${i}:`, err)
        startDeviceSentence(i + 1)
      },
    })
  }

  const stopDevice = () => {
    deviceTokenRef.current++
    cancelSpeech()
  }

  // ---------- shared playback control ----------

  const startSentence = (i: number, viaChain = false) => {
    const sents = sentencesRef.current
    while (i < sents.length && failedRef.current.has(i)) i++
    if (i >= sents.length) {
      // reached the end — reset to the top
      setPhase('ready')
      setHighlight(null)
      setCurrentSentence(0)
      return
    }
    setCurrentSentence(i)
    setHighlight({ s: i, w: 0 })
    if (!cacheRef.current.get(i)) {
      // an uncached sentence reached during continuous playback is an
      // underrun (a user jump is not)
      if (viaChain) registerGap()
      // cold start: this sentence's pieces enter the queue before prefetch
      setPhase('buffering')
      waitingForRef.current = { s: i, chunk: 0 }
      void synthesizeSentence(i, epochRef.current)
      prefetchFrom(i + 1)
      return
    }
    prefetchFrom(i + 1)
    playChunk(i, 0)
  }

  const play = () => {
    if (sentencesRef.current.length === 0) return
    if (engineRef.current === 'device') {
      // pause is cancel-based, so resume restarts the current sentence
      startDeviceSentence(currentRef.current)
      return
    }
    if (modelStatusRef.current !== 'ready') return
    playerRef.current.unlock()
    if (phaseRef.current === 'paused' && playerRef.current.hasSource) {
      playerRef.current.resume()
      setPhase('playing')
      return
    }
    startSentence(currentRef.current)
  }

  const pause = () => {
    if (engineRef.current === 'device') {
      if (phaseRef.current !== 'playing') return
      stopDevice()
      setPhase('paused')
      return
    }
    if (phaseRef.current === 'buffering') {
      waitingForRef.current = null
      setPhase('paused')
      return
    }
    if (phaseRef.current !== 'playing') return
    playerRef.current.pause()
    setPhase('paused')
  }

  const cancelInFlight = () => {
    epochRef.current++
    waitingForRef.current = null
    ttsRef.current?.cancelAll()
    pendingRef.current.clear()
  }

  const stopAll = () => {
    cancelInFlight()
    playingChunkRef.current = null
    playerRef.current.stop()
    stopDevice()
  }

  const jumpTo = (s: number) => {
    if (s < 0 || s >= sentencesRef.current.length) return
    failedRef.current.delete(s)
    if (engineRef.current === 'device') {
      stopDevice()
      startDeviceSentence(s)
      return
    }
    if (modelStatusRef.current !== 'ready') {
      // model still downloading: just move the cursor so play starts here
      setCurrentSentence(s)
      setHighlight({ s, w: 0 })
      return
    }
    cancelInFlight()
    playerRef.current.unlock()
    playerRef.current.stop()
    startSentence(s)
  }

  const flushAudio = () => {
    const wasPlaying = phaseRef.current === 'playing' || phaseRef.current === 'buffering'
    if (engineRef.current === 'device') {
      stopDevice()
      if (wasPlaying) startDeviceSentence(currentRef.current)
      else if (phaseRef.current === 'paused') setPhase('ready')
      return
    }
    cancelInFlight()
    playingChunkRef.current = null
    cacheRef.current.clear()
    failedRef.current.clear()
    playerRef.current.stop()
    if (wasPlaying) {
      startSentence(currentRef.current)
    } else if (phaseRef.current === 'paused') {
      // resume would replay stale audio; next play restarts the sentence instead
      setPhase('ready')
    }
  }

  const setSpeed = (v: number) => {
    if (v === speedRef.current) return
    speedRef.current = v
    setSpeedState(v)
    savePrefs({ speed: v })
    flushAudio()
  }

  const setVoice = (v: string) => {
    if (v === voiceRef.current) return
    voiceRef.current = v
    setVoiceState(v)
    savePrefs({ voice: v })
    flushAudio()
  }

  const setDeviceVoiceUri = (uri: string) => {
    if (uri === deviceVoiceUriRef.current) return
    deviceVoiceUriRef.current = uri
    setDeviceVoiceUriState(uri)
    savePrefs({ deviceVoice: uri })
    flushAudio()
  }

  const setEngine = (e: Engine) => {
    if (e === engineRef.current) return
    stopAll()
    gapCountRef.current = 0
    prefetchAheadRef.current = PREFETCH_MIN
    setHint(null)
    engineRef.current = e
    setEngineState(e)
    localStorage.setItem('audio-read-engine', e)
    if (phaseRef.current === 'playing' || phaseRef.current === 'buffering' || phaseRef.current === 'paused') {
      setPhase('ready')
    }
    if (e === 'kokoro' && sentencesRef.current.length > 0) initModel()
  }

  const initModel = () => {
    if (engineRef.current !== 'kokoro') return
    if (modelStatusRef.current !== 'idle') return
    setModelStatus('loading')
    setError(null)
    progressFilesRef.current.clear()
    setModelProgress({ loaded: 0, total: 0 })
    if (!ttsRef.current) ttsRef.current = new TtsClient()
    ttsRef.current
      .init((p) => {
        progressFilesRef.current.set(p.file, p)
        let loaded = 0
        let total = 0
        for (const f of progressFilesRef.current.values()) {
          loaded += f.loaded
          total += f.total
        }
        setModelProgress({ loaded, total })
      })
      .then((dev) => {
        setDevice(dev)
        setModelStatus('ready')
        prefetchFrom(currentRef.current)
      })
      .catch((e: Error) => {
        // the worker is dead — throw the client away so Retry starts clean
        ttsRef.current?.dispose()
        ttsRef.current = null
        setModelStatus('idle')
        setError(`Failed to load the voice model: ${e.message}`)
      })
  }

  /** Retry a failed model load (the worker is recreated from scratch). */
  const retryModel = () => initModel()

  const loadDocument = async (file: File) => {
    setError(null)
    setHint(null)
    gapCountRef.current = 0
    prefetchAheadRef.current = PREFETCH_MIN
    setPhase('extracting')
    try {
      const [paragraphs, key] = await Promise.all([extractParagraphs(file), docKey(file)])
      const segs = segmentParagraphs(paragraphs)
      if (segs.length === 0) throw new NoTextError()
      stopAll()
      cacheRef.current.clear()
      failedRef.current.clear()
      sentencesRef.current = segs
      const prefix = [0]
      for (const s of segs) prefix.push(prefix[prefix.length - 1] + sentenceWeight(s))
      prefixRef.current = prefix
      setSentences(segs)
      docKeyRef.current = key
      // resume where this document was left off
      const saved = loadPosition(key)
      const startAt = saved != null && saved > 0 && saved < segs.length ? saved : 0
      setCurrentSentence(startAt)
      setHighlight(startAt > 0 ? { s: startAt, w: 0 } : null)
      setPhase('ready')
      initModel()
    } catch (e) {
      setPhase('idle')
      setError(e instanceof NoTextError ? e.message : `Could not read this PDF: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const reset = () => {
    stopAll()
    docKeyRef.current = null
    cacheRef.current.clear()
    failedRef.current.clear()
    sentencesRef.current = []
    prefixRef.current = [0]
    setSentences([])
    setCurrentSentence(0)
    setHighlight(null)
    setError(null)
    setPhase('idle')
  }

  // discover the OS/browser voices once
  useEffect(() => {
    void loadDeviceVoices().then((voices) => {
      deviceVoicesRef.current = voices
      setDeviceVoices(voices)
      if (voices.length && !deviceVoiceUriRef.current) {
        // saved preference if still installed, else a local (offline) voice
        const savedUri = loadPrefs().deviceVoice
        const preferred =
          voices.find((v) => v.voiceURI === savedUri) ??
          voices.find((v) => v.localService) ??
          voices[0]
        deviceVoiceUriRef.current = preferred.voiceURI
        setDeviceVoiceUriState(preferred.voiceURI)
      }
    })
  }, [])

  // word highlighter for the kokoro engine: poll the audio clock
  // (the device engine gets real word boundaries from speechSynthesis instead)
  useEffect(() => {
    if (phase !== 'playing' || engine !== 'kokoro') return
    let raf = 0
    const tick = () => {
      const pc = playingChunkRef.current
      const player = playerRef.current
      if (pc && player.currentDuration > 0) {
        const s = sentencesRef.current[pc.s]
        const chunk = cacheRef.current.get(pc.s)?.chunks[pc.chunk]
        if (s && chunk) {
          const w = wordIndexInRange(s, chunk.fromWord, chunk.toWord, player.elapsed / player.currentDuration)
          setHighlight((prev) => (prev && prev.s === pc.s && prev.w === w ? prev : { s: pc.s, w }))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, engine])

  // time estimates, refreshed twice a second
  useEffect(() => {
    const id = setInterval(() => {
      const n = sentencesRef.current.length
      if (n === 0) {
        setTimes((prev) => (prev.total === 0 && prev.remaining === 0 ? prev : { total: 0, remaining: 0 }))
        return
      }
      const prefix = prefixRef.current
      const est = estimatorRef.current
      const spd = speedRef.current
      const total = est.seconds(prefix[n], spd)
      const i = Math.min(currentRef.current, n - 1)
      let remaining = est.seconds(prefix[n] - prefix[i], spd)
      if (engineRef.current === 'kokoro' && (phaseRef.current === 'playing' || phaseRef.current === 'paused')) {
        remaining -= Math.min(playerRef.current.elapsed, est.seconds(prefix[i + 1] - prefix[i], spd))
      }
      setTimes((prev) => {
        const t = Math.round(total)
        const r = Math.max(0, Math.round(remaining))
        return prev.total === t && prev.remaining === r ? prev : { total: t, remaining: r }
      })
    }, 500)
    return () => clearInterval(id)
  }, [])

  return {
    phase,
    sentences,
    current,
    highlight,
    voice,
    speed,
    engine,
    deviceVoices,
    deviceVoiceUri,
    modelStatus,
    modelProgress,
    device,
    error,
    hint,
    dismissHint: () => setHint(null),
    times,
    loadDocument,
    play,
    pause,
    jumpTo,
    setSpeed,
    setVoice,
    setEngine,
    setDeviceVoiceUri,
    retryModel,
    reset,
  }
}
