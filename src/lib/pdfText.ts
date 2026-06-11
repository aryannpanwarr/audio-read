/**
 * Pure text-reconstruction logic for PDF extraction: pdf.js gives an unordered
 * soup of positioned text items; this rebuilds lines (by y), reading order
 * (by x), and paragraphs (by vertical gaps + font-height changes).
 * Kept free of pdf.js imports so it can be tested in plain Node.
 */

export interface Paragraph {
  text: string
  heading: boolean
}

export interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

export interface Line {
  y: number
  h: number
  /** x where the line starts — used to detect first-line paragraph indents */
  x: number
  /** x where the line ends — short lines in justified text end paragraphs */
  endX: number
  text: string
}

export function buildLines(items: PdfTextItem[]): Line[] {
  const raw: { y: number; h: number; parts: { x: number; w: number; str: string }[] }[] = []
  for (const item of items) {
    if (!item.str.trim()) continue
    const x = item.transform[4]
    const y = item.transform[5]
    const h = item.height || Math.abs(item.transform[3]) || 10
    let line = raw.find((l) => Math.abs(l.y - y) < Math.max(2, h * 0.4))
    if (!line) {
      line = { y, h, parts: [] }
      raw.push(line)
    }
    line.h = Math.max(line.h, h)
    line.parts.push({ x, w: item.width ?? 0, str: item.str })
  }

  const out: Line[] = []
  for (const l of raw.sort((a, b) => b.y - a.y)) {
    l.parts.sort((a, b) => a.x - b.x)
    let text = ''
    let prevEnd: number | null = null
    for (const p of l.parts) {
      if (prevEnd !== null && p.x - prevEnd > 1 && text && !text.endsWith(' ') && !p.str.startsWith(' ')) {
        text += ' '
      }
      text += p.str
      prevEnd = p.x + p.w
    }
    // strip TOC dot leaders and collapse whitespace
    text = text.replace(/(?:[.·․]\s*){4,}/g, ' ').replace(/\s+/g, ' ').trim()
    // drop empties and page-number/footer junk
    if (!text || /^[\d\s.•–-]{1,10}$/.test(text)) continue
    const last = l.parts[l.parts.length - 1]
    out.push({ y: l.y, h: l.h, x: l.parts[0].x, endX: last.x + last.w, text })
  }
  return out
}

/** Remove running headers/footers: edge lines whose exact text repeats on many pages. */
export function dropRunningHeaders(pages: Line[][]) {
  if (pages.length < 8) return
  const counts = new Map<string, number>()
  for (const lines of pages) {
    const edge = new Set([lines[0]?.text, lines[lines.length - 1]?.text])
    for (const t of edge) if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const threshold = pages.length / 3
  for (let i = 0; i < pages.length; i++) {
    pages[i] = pages[i].filter(
      (l, idx, arr) =>
        !((idx === 0 || idx === arr.length - 1) && (counts.get(l.text) ?? 0) > threshold),
    )
  }
}

const endsTerminal = (s: string) => /[.!?…][”'")\]]?$/.test(s)

export function buildParagraphs(pages: Line[][]): Paragraph[] {
  const heights = pages
    .flat()
    .map((l) => l.h)
    .sort((a, b) => a - b)
  const bodyH = heights[Math.floor(heights.length / 2)] ?? 12

  // measure the document's own line spacing: paragraph breaks are gaps
  // clearly larger than the typical (median) leading between lines
  const gaps: number[] = []
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y
      if (g > 0 && g < bodyH * 5) gaps.push(g)
    }
  }
  gaps.sort((a, b) => a - b)
  const leading = gaps[Math.floor(gaps.length / 2)] ?? bodyH * 1.5

  const paragraphs: Paragraph[] = []
  let cur: { text: string; h: number } | null = null

  const flush = () => {
    if (cur && cur.text) paragraphs.push({ text: cur.text, heading: cur.h > bodyH * 1.25 })
    cur = null
  }

  for (const lines of pages) {
    // the column's left margin: the most common line-start x on this page
    const xCounts = new Map<number, number>()
    for (const l of lines) {
      const k = Math.round(l.x)
      xCounts.set(k, (xCounts.get(k) ?? 0) + 1)
    }
    let marginX = 0
    let best = -1
    for (const [x, n] of xCounts) {
      if (n > best || (n === best && x < marginX)) {
        best = n
        marginX = x
      }
    }
    const colRight = Math.max(...lines.map((l) => l.endX), marginX)
    const colW = colRight - marginX

    let prev: Line | null = null // previous line on *this* page
    let prevGap = Infinity // distance prev sat below ITS predecessor
    for (const line of lines) {
      let breakPara = false
      if (!cur) {
        breakPara = true
      } else if (prev) {
        const gap = prev.y - line.y
        if (gap > leading * 1.45) breakPara = true // larger than normal line spacing
        if (Math.abs(line.h - cur.h) > Math.max(line.h, cur.h) * 0.2) breakPara = true // font size change
        // LaTeX-style first-line indent (guarded by gap so justified-text
        // fragments sitting between baselines can't trigger it)
        if (line.x - marginX > bodyH * 0.8 && gap >= leading * 0.8) breakPara = true
        // justified text: a paragraph's final line ends short of the right
        // margin; fragments (lines squeezed below their predecessor at less
        // than normal leading) are rendering artifacts, never paragraph ends
        // (paragraph-final lines also end a sentence — guards ragged-right
        // PDFs where many mid-paragraph lines end short)
        const prevShort = prev.endX < marginX + colW * 0.8 && endsTerminal(prev.text)
        const prevIsFragment = prevGap < leading * 0.9
        if (prevShort && !prevIsFragment && gap >= leading * 0.9 && colW > 100) breakPara = true
        prevGap = gap
      } else {
        // first line of a new page: continue the open paragraph only if it
        // looks unfinished and the font size matches
        if (endsTerminal(cur.text) || Math.abs(line.h - cur.h) > Math.max(line.h, cur.h) * 0.2) {
          breakPara = true
        }
      }
      if (breakPara) {
        flush()
        cur = { text: line.text, h: line.h }
      } else if (cur) {
        // de-hyphenate words broken across lines
        cur.text = cur.text.endsWith('-')
          ? cur.text.slice(0, -1) + line.text
          : cur.text + ' ' + line.text
        cur.h = Math.max(cur.h, line.h)
      }
      prev = line
    }
  }
  flush()
  return paragraphs
}
