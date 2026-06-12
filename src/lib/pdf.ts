import { buildLines, buildParagraphs, dropRunningHeaders, type Line, type Paragraph } from './pdfText'

export type { Paragraph }

export class NoTextError extends Error {
  constructor() {
    super('No readable text found in this PDF — it is probably a scanned document. OCR is not supported.')
    this.name = 'NoTextError'
  }
}

const PAGE_BATCH = 16

export async function extractParagraphs(file: File): Promise<Paragraph[]> {
  // pdf.js is ~400KB — load it only when a file actually arrives
  const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = worker.default

  const data = await file.arrayBuffer()
  const loadingTask = getDocument({ data })
  const doc = await loadingTask.promise
  try {
    const pages: Line[][] = new Array<Line[]>(doc.numPages)
    for (let start = 1; start <= doc.numPages; start += PAGE_BATCH) {
      const end = Math.min(start + PAGE_BATCH - 1, doc.numPages)
      await Promise.all(
        Array.from({ length: end - start + 1 }, async (_, j) => {
          const pageNo = start + j
          const page = await doc.getPage(pageNo)
          const content = await page.getTextContent()
          pages[pageNo - 1] = buildLines(content.items.filter((it) => 'str' in it))
          page.cleanup()
        }),
      )
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
