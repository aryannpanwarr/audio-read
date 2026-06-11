import { memo, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import type { Sentence } from '../types'
import type { Highlight } from '../hooks/useReader'

interface SentenceProps {
  sentence: Sentence
  highlightWord: number | null
  isCurrent: boolean
}

const SentenceSpan = memo(function SentenceSpan({ sentence, highlightWord, isCurrent }: SentenceProps) {
  const nodes: (string | React.JSX.Element)[] = []
  let pos = 0
  sentence.words.forEach((w, wi) => {
    if (w.start > pos) nodes.push(sentence.text.slice(pos, w.start))
    nodes.push(
      <span
        key={wi}
        className={'word' + (wi === highlightWord ? ' word-hl' : '')}
        data-s={sentence.index}
        data-w={wi}
      >
        {w.text}
      </span>,
    )
    pos = w.end
  })
  if (pos < sentence.text.length) nodes.push(sentence.text.slice(pos))
  return (
    <span className={'sentence' + (isCurrent ? ' sentence-cur' : '')} data-sentence={sentence.index}>
      {nodes}{' '}
    </span>
  )
})

interface Props {
  sentences: Sentence[]
  highlight: Highlight | null
  current: number
  isPlaying: boolean
  onWordClick: (sentenceIndex: number) => void
}

export function ReaderView({ sentences, highlight, current, isPlaying, onWordClick }: Props) {
  const lastManualScrollRef = useRef(0)

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const s = target.dataset.s
    if (s != null) onWordClick(Number(s))
  }

  // suppress auto-scroll for a moment after the user scrolls by hand
  useEffect(() => {
    const mark = () => {
      lastManualScrollRef.current = Date.now()
    }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchmove', mark, { passive: true })
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchmove', mark)
    }
  }, [])

  useEffect(() => {
    if (!isPlaying) return
    if (Date.now() - lastManualScrollRef.current < 3000) return
    document
      .querySelector(`[data-sentence="${current}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current, isPlaying])

  const paragraphs = useMemo(() => {
    const groups: { para: number; heading: boolean; sentences: Sentence[] }[] = []
    for (const s of sentences) {
      const last = groups[groups.length - 1]
      if (last && last.para === s.para) last.sentences.push(s)
      else groups.push({ para: s.para, heading: s.heading, sentences: [s] })
    }
    return groups
  }, [sentences])

  return (
    <div className="reader" onClick={handleClick}>
      {paragraphs.map((g) => {
        const body = g.sentences.map((s) => (
          <SentenceSpan
            key={s.index}
            sentence={s}
            highlightWord={highlight && highlight.s === s.index ? highlight.w : null}
            isCurrent={s.index === current}
          />
        ))
        return g.heading ? <h3 key={g.para}>{body}</h3> : <p key={g.para}>{body}</p>
      })}
    </div>
  )
}
