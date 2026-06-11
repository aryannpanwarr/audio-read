import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export class NoTextError extends Error {
  constructor() {
    super('No readable text found in this PDF — it is probably a scanned document. OCR is not supported.')
    this.name = 'NoTextError'
  }
}

export async function extractText(file: File): Promise<string> {
  const data = await file.arrayBuffer()
  const loadingTask = getDocument({ data })
  const doc = await loadingTask.promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let t = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        t += item.str
        if (item.hasEOL) {
          // de-hyphenate words broken across lines, otherwise treat EOL as a space
          t = t.endsWith('-') ? t.slice(0, -1) : t + ' '
        }
      }
      pages.push(t.replace(/\s+/g, ' ').trim())
      page.cleanup()
    }
    const text = pages.filter(Boolean).join('\n\n')
    const chars = text.replace(/\s/g, '').length
    if (chars < 50 || chars / doc.numPages < 25) throw new NoTextError()
    return text
  } finally {
    void loadingTask.destroy()
  }
}
