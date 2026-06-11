import { useEffect, useRef, useState } from 'react'
import type { Sentence } from '../types'
import { extractParagraphs, NoTextError } from '../lib/pdf'
import { segmentParagraphs, sentenceWeight, wordIndexAtFraction } from '../lib/segment'
import { TimeEstimator } from '../lib/estimate'
import { TtsClient, CancelledError, type ProgressInfo } from '../tts/ttsClient'
import { DEFAULT_VOICE } from '../tts/voices'
import { Player } from '../audio/player'

export type Phase = 'idle' | 'extracting' | 'ready' | 'playing' | 'paused' | 'buffering'
export type ModelStatus = 'idle' | 'loading' | 'ready'

export interface Highlight {
  s: number
  w: number
}

const PREFETCH_AHEAD = 2
const CACHE_LIMIT = 24

export function useReader() {
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [sentences, setSentences] = useState<Sentence[]>([])
  const [current, setCurrent] = useState(0)
  const [highlight, setHighlight] = useState<Highlight | null>(null)
  const [voice, setVoiceState] = useState(DEFAULT_VOICE)
  const [speed, setSpeedState] = useState(1)
  const [modelStatus, setModelStatusState] = useState<ModelStatus>('idle')
  const [modelProgress, setModelProgress] = useState({ loaded: 0, total: 0 })
  const [device, setDevice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [times, setTimes] = useState({ total: 0, remaining: 0 })

  const phaseRef = useRef<Phase>('idle')
  const sentencesRef = useRef<Sentence[]>([])
  const prefixRef = useRef<number[]>([0]) // prefix[i] = total weight of sentences 0..i-1
  const currentRef = useRef(0)
  const voiceRef = useRef(DEFAULT_VOICE)
  const speedRef = useRef(1)
  const modelStatusRef = useRef<ModelStatus>('idle')
  const epochRef = useRef(0)
  const waitingForRef = useRef<number | null>(null)
  const cacheRef = useRef(new Map<number, AudioBuffer>())
  const pendingRef = useRef(new Set<number>())
  const failedRef = useRef(new Set<number>())
  const ttsRef = useRef<TtsClient | null>(null)
  const playerRef = useRef(new Player())
  const estimatorRef = useRef(new TimeEstimator())
  const progressFilesRef = useRef(new Map<string, ProgressInfo>())

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
  }

  const synthesizeSentence = async (i: number, epoch: number) => {
    const sents = sentencesRef.current
    const cache = cacheRef.current
    if (i >= sents.length || cache.has(i) || pendingRef.current.has(i) || failedRef.current.has(i)) return
    if (!ttsRef.current || modelStatusRef.current !== 'ready') return
    pendingRef.current.add(i)
    try {
      const { samples, sampleRate } = await ttsRef.current.synthesize(
        sents[i].text,
        voiceRef.current,
        speedRef.current,
      )
      if (epoch !== epochRef.current) return
      const buf = playerRef.current.makeBuffer(samples, sampleRate)
      cache.set(i, buf)
      estimatorRef.current.observe(sentenceWeight(sents[i]), buf.duration, speedRef.current)
      evictCache()
      if (waitingForRef.current === i) {
        waitingForRef.current = null
        startSentence(i)
      }
    } catch (e) {
      if (e instanceof CancelledError || epoch !== epochRef.current) return
      console.error(`Synthesis failed for sentence ${i}:`, e)
      failedRef.current.add(i)
      if (waitingForRef.current === i) {
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
    for (let i = from; i < Math.min(from + PREFETCH_AHEAD + 1, sentencesRef.current.length); i++) {
      void synthesizeSentence(i, epoch)
    }
  }

  const startSentence = (i: number) => {
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
    prefetchFrom(i)
    const buf = cacheRef.current.get(i)
    if (!buf) {
      setPhase('buffering')
      waitingForRef.current = i
      return
    }
    setPhase('playing')
    playerRef.current.play(buf, () => startSentence(i + 1))
  }

  const play = () => {
    if (modelStatusRef.current !== 'ready' || sentencesRef.current.length === 0) return
    playerRef.current.unlock()
    if (phaseRef.current === 'paused' && playerRef.current.hasSource) {
      playerRef.current.resume()
      setPhase('playing')
      return
    }
    startSentence(currentRef.current)
  }

  const pause = () => {
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

  const jumpTo = (s: number) => {
    if (s < 0 || s >= sentencesRef.current.length) return
    failedRef.current.delete(s)
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
    cancelInFlight()
    cacheRef.current.clear()
    failedRef.current.clear()
    const wasPlaying = phaseRef.current === 'playing' || phaseRef.current === 'buffering'
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
    flushAudio()
  }

  const setVoice = (v: string) => {
    if (v === voiceRef.current) return
    voiceRef.current = v
    setVoiceState(v)
    flushAudio()
  }

  const initModel = () => {
    if (modelStatusRef.current !== 'idle') return
    setModelStatus('loading')
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
        setModelStatus('idle')
        setError(`Failed to load the voice model: ${e.message}`)
      })
  }

  const loadDocument = async (file: File) => {
    setError(null)
    setPhase('extracting')
    try {
      const paragraphs = await extractParagraphs(file)
      const segs = segmentParagraphs(paragraphs)
      if (segs.length === 0) throw new NoTextError()
      cancelInFlight()
      playerRef.current.stop()
      cacheRef.current.clear()
      failedRef.current.clear()
      sentencesRef.current = segs
      const prefix = [0]
      for (const s of segs) prefix.push(prefix[prefix.length - 1] + sentenceWeight(s))
      prefixRef.current = prefix
      setSentences(segs)
      setCurrentSentence(0)
      setHighlight(null)
      setPhase('ready')
      initModel()
    } catch (e) {
      setPhase('idle')
      setError(e instanceof NoTextError ? e.message : `Could not read this PDF: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const reset = () => {
    cancelInFlight()
    playerRef.current.stop()
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

  // word highlighter: poll the audio clock, update state only when the word changes
  useEffect(() => {
    if (phase !== 'playing') return
    let raf = 0
    const tick = () => {
      const i = currentRef.current
      const s = sentencesRef.current[i]
      const player = playerRef.current
      if (s && player.currentDuration > 0) {
        const w = wordIndexAtFraction(s, player.elapsed / player.currentDuration)
        setHighlight((prev) => (prev && prev.s === i && prev.w === w ? prev : { s: i, w }))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase])

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
      if (phaseRef.current === 'playing' || phaseRef.current === 'paused') {
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
    modelStatus,
    modelProgress,
    device,
    error,
    times,
    loadDocument,
    play,
    pause,
    jumpTo,
    setSpeed,
    setVoice,
    reset,
  }
}
