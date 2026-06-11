/**
 * Browser/OS native speech (Web Speech API) — the phone-friendly engine:
 * no model download, instant start, and real word-boundary events.
 */

export const hasDeviceTts = () => typeof window !== 'undefined' && 'speechSynthesis' in window

export function loadDeviceVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!hasDeviceTts()) return resolve([])
    const synth = window.speechSynthesis
    const filter = (all: SpeechSynthesisVoice[]) => {
      const us = all.filter((v) => /^en[-_]US/i.test(v.lang))
      return us.length ? us : all.filter((v) => /^en/i.test(v.lang))
    }
    const now = synth.getVoices()
    if (now.length) return resolve(filter(now))
    // voices load asynchronously on most browsers
    synth.addEventListener('voiceschanged', () => resolve(filter(synth.getVoices())), { once: true })
    setTimeout(() => resolve(filter(synth.getVoices())), 2000)
  })
}

export interface SpeakCallbacks {
  /** character offset into the text of the word now being spoken */
  onBoundary: (charIndex: number) => void
  onEnd: () => void
  onError: (error: string) => void
}

// hold a reference so Chrome doesn't garbage-collect the utterance mid-speech
// (a long-standing bug that silently stops events)
let activeUtterance: SpeechSynthesisUtterance | null = null

export function speak(
  text: string,
  voice: SpeechSynthesisVoice | null,
  rate: number,
  cb: SpeakCallbacks,
) {
  const u = new SpeechSynthesisUtterance(text)
  if (voice) u.voice = voice
  u.rate = rate
  u.onboundary = (e) => {
    if (e.name === 'sentence') return
    cb.onBoundary(e.charIndex ?? 0)
  }
  u.onend = () => {
    if (activeUtterance === u) activeUtterance = null
    cb.onEnd()
  }
  u.onerror = (e) => {
    if (activeUtterance === u) activeUtterance = null
    // cancel() reports these on various browsers; they are not failures
    if (e.error === 'interrupted' || e.error === 'canceled') return
    cb.onError(e.error)
  }
  activeUtterance = u
  window.speechSynthesis.speak(u)
}

/** Hard stop. We implement pause as cancel+restart-of-sentence because
 * speechSynthesis.pause() is unreliable on Android Chrome. */
export function cancelSpeech() {
  activeUtterance = null
  if (hasDeviceTts()) window.speechSynthesis.cancel()
}
