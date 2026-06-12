import { memo, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import type { Sentence } from '../types'
import type { Highlight } from '../hooks/useReader'

/** sentences within this distance of the current one get per-word spans */
const ACTIVE_WINDOW = 4

interface SentenceProps {
  sentence: Sentence
  /** render per-word spans (only needed near the playing sentence) */
  active: boolean
  highlightWord: number | null
  isCurrent: boolean
}

const SentenceSpan = memo(function SentenceSpan({ sentence, active, highlightWord, isCurrent }: SentenceProps) {
  const cls = 'sentence' + (isCurrent ? ' sentence-cur' : '')
  if (!active) {
    // plain text keeps the DOM ~15× smaller on big documents
    return (
      <span className={cls} data-sentence={sentence.index} data-s={sentence.index}>
        {sentence.text}{' '}
      </span>
    )
  }
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
    <span className={cls} data-sentence={sentence.index}>
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
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-s]')
    if (el?.dataset.s != null) onWordClick(Number(el.dataset.s))
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

  // when a document opens at a remembered position, jump the view there
  useEffect(() => {
    if (sentences.length === 0 || current === 0) return
    document.querySelector(`[data-sentence="${current}"]`)?.scrollIntoView({ block: 'center' })
    // run only when the document itself changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentences])

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
            active={Math.abs(s.index - current) <= ACTIVE_WINDOW}
            highlightWord={highlight && highlight.s === s.index ? highlight.w : null}
            isCurrent={s.index === current}
          />
        ))
        return g.heading ? <h3 key={g.para}>{body}</h3> : <p key={g.para}>{body}</p>
      })}
    </div>
  )
}

