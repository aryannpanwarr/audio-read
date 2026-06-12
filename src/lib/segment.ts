import type { Sentence, Word } from '../types'
import type { Paragraph } from './pdfText'

/** Kokoro truncates past ~510 phonemes; shorter chunks also mean less
 * in-flight synthesis blocking the queue when the user jumps around. */
const MAX_CHARS = 300

export function segmentParagraphs(paragraphs: Paragraph[]): Sentence[] {
  const sentenceSeg = new Intl.Segmenter('en', { granularity: 'sentence' })
  const wordSeg = new Intl.Segmenter('en', { granularity: 'word' })
  const sentences: Sentence[] = []
  paragraphs.forEach((para, pi) => {
    for (const seg of sentenceSeg.segment(para.text)) {
      for (const chunk of splitLong(seg.segment)) {
        const words: Word[] = []
        for (const w of wordSeg.segment(chunk)) {
          if (w.isWordLike) {
            words.push({ text: w.segment, start: w.index, end: w.index + w.segment.length })
          }
        }
        if (words.length === 0) continue
        sentences.push({
          index: sentences.length,
          text: chunk,
          words,
          para: pi,
          heading: para.heading,
        })
      }
    }
  })
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

/** Total weight of words [from, to). */
export function rangeWeight(s: Sentence, from: number, to: number): number {
  const cum = cumWeights(s)
  return cum[to] - cum[from]
}

/** Which word in [from, to) is being spoken at `fraction` of that range's audio. */
export function wordIndexInRange(s: Sentence, from: number, to: number, fraction: number): number {
  const cum = cumWeights(s)
  const target = cum[from] + fraction * (cum[to] - cum[from])
  let k = from
  while (k < to - 1 && cum[k + 1] <= target) k++
  return k
}

/**
 * Word indices where each synthesis chunk of a sentence starts (always
 * includes 0). The opening chunk is kept small (~90 chars) so audio starts
 * fast; later chunks are larger (~200) to preserve prosody. Splits prefer
 * clause boundaries. Capping chunk size also bounds how long any single
 * (unabortable) inference can block the synthesis queue.
 */
export function chunkBoundaries(s: Sentence): number[] {
  const n = s.words.length
  const bounds = [0]
  if (s.text.length <= 150 || n < 8) return bounds
  let target = 90
  let startChar = 0
  let lastClause = -1
  for (let i = 0; i < n - 1; i++) {
    const end = s.words[i].end
    const between = s.text.slice(end, s.words[i + 1].start)
    if (/[,;:]/.test(between)) lastClause = i + 1
    if (end - startChar >= target) {
      const startWord = bounds[bounds.length - 1]
      const cut = lastClause > startWord ? lastClause : i + 1
      if (cut >= n || s.text.length - s.words[cut].start < 40) break // tail too small to split off
      bounds.push(cut)
      startChar = s.words[cut].start
      lastClause = -1
      target = 200
    }
  }
  return bounds
}
