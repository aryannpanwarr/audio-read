import type { Sentence, Word } from '../types'

/** Kokoro truncates past ~510 phonemes, so cap sentence length well below that. */
const MAX_CHARS = 400

export function segmentText(text: string): Sentence[] {
  const sentenceSeg = new Intl.Segmenter('en', { granularity: 'sentence' })
  const wordSeg = new Intl.Segmenter('en', { granularity: 'word' })
  const sentences: Sentence[] = []
  for (const seg of sentenceSeg.segment(text)) {
    for (const chunk of splitLong(seg.segment)) {
      const words: Word[] = []
      for (const w of wordSeg.segment(chunk)) {
        if (w.isWordLike) {
          words.push({ text: w.segment, start: w.index, end: w.index + w.segment.length })
        }
      }
      if (words.length === 0) continue
      sentences.push({ index: sentences.length, text: chunk, words })
    }
  }
  return sentences
}

function splitLong(s: string): string[] {
  if (s.length <= MAX_CHARS) return [s]
  let cut = -1
  for (const m of s.slice(0, MAX_CHARS).matchAll(/[,;:](?=\s)/g)) cut = m.index + 1
  if (cut < MAX_CHARS / 4) {
    cut = s.lastIndexOf(' ', MAX_CHARS)
    if (cut <= 0) cut = MAX_CHARS
  }
  return [s.slice(0, cut), ...splitLong(s.slice(cut))]
}

/**
 * Word timing weights: kokoro-js gives no word timestamps, so we spread each
 * sentence's real audio duration across its words proportionally to length.
 * The +2 approximates the per-word floor and inter-word gap.
 */
export function wordWeight(word: string): number {
  return word.length + 2
}

const cumCache = new WeakMap<Sentence, number[]>()

function cumWeights(s: Sentence): number[] {
  let arr = cumCache.get(s)
  if (!arr) {
    arr = [0]
    for (const w of s.words) arr.push(arr[arr.length - 1] + wordWeight(w.text))
    cumCache.set(s, arr)
  }
  return arr
}

export function sentenceWeight(s: Sentence): number {
  const c = cumWeights(s)
  return c[c.length - 1]
}

/** Which word is being spoken at `fraction` (0..1) of the sentence audio. */
export function wordIndexAtFraction(s: Sentence, fraction: number): number {
  const cum = cumWeights(s)
  const target = fraction * cum[cum.length - 1]
  let k = 0
  while (k < s.words.length - 1 && cum[k + 1] <= target) k++
  return k
}
