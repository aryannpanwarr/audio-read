import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { buildLines, buildParagraphs, dropRunningHeaders, type Line, type Paragraph } from './pdfText'

GlobalWorkerOptions.workerSrc = workerUrl

export type { Paragraph }

export class NoTextError extends Error {
  constructor() {
    super('No readable text found in this PDF — it is probably a scanned document. OCR is not supported.')
    this.name = 'NoTextError'
  }
}

export async function extractParagraphs(file: File): Promise<Paragraph[]> {
  const data = await file.arrayBuffer()
  const loadingTask = getDocument({ data })
  const doc = await loadingTask.promise
  try {
    const pages: Line[][] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(buildLines(content.items.filter((it) => 'str' in it)))
      page.cleanup()
    }
    dropRunningHeaders(pages)
    const paragraphs = buildParagraphs(pages)
    const chars = paragraphs.map((p) => p.text).join('').replace(/\s/g, '').length
    if (chars < 50 || chars / doc.numPages < 25) throw new NoTextError()
    return paragraphs
  } finally {
    void loadingTask.destroy()
  }
}
