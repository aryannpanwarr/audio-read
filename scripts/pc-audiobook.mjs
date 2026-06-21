#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { KokoroTTS } from 'kokoro-js'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const DEFAULT_VOICE = 'af_heart'
const MAX_CHARS = 280

const args = parseArgs(process.argv.slice(2))
if (!args.input || args.help) {
  printUsage()
  process.exit(args.help ? 0 : 1)
}

const inputPath = resolve(args.input)
if (!existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`)
  process.exit(1)
}

const outDir = resolve(args.out ?? join(process.cwd(), 'audiobook-output', safeBaseName(inputPath)))
mkdirSync(outDir, { recursive: true })

const voice = args.voice ?? DEFAULT_VOICE
const speed = Number(args.speed ?? '1')
const limit = args.limit ? Math.max(1, Number(args.limit)) : null

console.log(`Input: ${inputPath}`)
console.log(`Output: ${outDir}`)
console.log(`Voice: ${voice}`)
console.log(`Speed: ${speed}`)

const sections = await extractSections(inputPath)
const segments = makeSegments(sections).slice(0, limit ?? undefined)
if (!segments.length) {
  console.error('No readable text segments found.')
  process.exit(1)
}

console.log(`Segments: ${segments.length}${limit ? ' (limited sample)' : ''}`)
if (args.dryRun) {
  const preview = {
    source: inputPath,
    title: stripExt(basename(inputPath)),
    sections: sections.length,
    segments: segments.length,
    sample: segments.slice(0, 10),
  }
  writeFileSync(join(outDir, 'dry-run.json'), JSON.stringify(preview, null, 2))
  writeFileSync(join(outDir, 'transcript.txt'), segments.map((s) => s.text).join('\n\n'))
  console.log(`Dry run written: ${join(outDir, 'dry-run.json')}`)
  process.exit(0)
}
console.log('Loading Kokoro...')
const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
  dtype: args.dtype ?? 'q8',
  device: 'cpu',
  progress_callback: (p) => {
    if (p.status === 'progress' && p.total) {
      const pct = Math.round((p.loaded / p.total) * 100)
      process.stdout.write(`\rDownloading ${p.file ?? ''} ${pct}%`)
    }
  },
})
process.stdout.write('\n')

const manifest = {
  version: 1,
  source: inputPath,
  title: stripExt(basename(inputPath)),
  model: MODEL_ID,
  voice,
  speed,
  generatedAt: new Date().toISOString(),
  audioFormat: 'wav',
  segments: [],
}

let cursor = 0
for (let i = 0; i < segments.length; i++) {
  const segment = segments[i]
  const name = `${String(i + 1).padStart(4, '0')}.wav`
  const audioPath = join(outDir, name)
  const label = `${i + 1}/${segments.length}`
  console.log(`[${label}] ${segment.text.slice(0, 80).replace(/\s+/g, ' ')}${segment.text.length > 80 ? '...' : ''}`)
  const started = performance.now()
  const audio = await tts.generate(segment.text, { voice, speed })
  audio.save(audioPath)
  const duration = audio.audio.length / audio.sampling_rate
  const elapsed = (performance.now() - started) / 1000
  manifest.segments.push({
    index: i,
    section: segment.section,
    audio: name,
    text: segment.text,
    start: round(cursor),
    end: round(cursor + duration),
    duration: round(duration),
    sampleRate: audio.sampling_rate,
    samples: audio.audio.length,
    generationSeconds: round(elapsed),
  })
  cursor += duration
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

manifest.duration = round(cursor)
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
writeFileSync(join(outDir, 'transcript.txt'), segments.map((s) => s.text).join('\n\n'))
console.log(`Done. Audio: ${outDir}`)
console.log(`Manifest: ${join(outDir, 'manifest.json')}`)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--input' || arg === '-i') out.input = argv[++i]
    else if (arg === '--out' || arg === '-o') out.out = argv[++i]
    else if (arg === '--voice') out.voice = argv[++i]
    else if (arg === '--speed') out.speed = argv[++i]
    else if (arg === '--dtype') out.dtype = argv[++i]
    else if (arg === '--limit') out.limit = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (!out.input) out.input = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

function printUsage() {
  console.log(`Usage:
  npm run audiobook -- --input book.epub --out out/book-sample --limit 5

Options:
  --input, -i   EPUB or TXT file
  --out, -o     Output folder
  --voice       Kokoro voice, default ${DEFAULT_VOICE}
  --speed       Speech speed, default 1
  --dtype       q8, fp32, fp16, q4, q4f16; default q8
  --limit       Generate only first N segments for a quick sample
  --dry-run     Extract/segment only; do not load Kokoro or generate audio`)
}

async function extractSections(filePath) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.txt') {
    return [{ title: stripExt(basename(filePath)), text: readFileSync(filePath, 'utf8') }]
  }
  if (ext === '.epub') return extractEpub(filePath)
  throw new Error('This first PC generator supports EPUB and TXT. PDF support needs a Node pdf.js path next.')
}

function extractEpub(filePath) {
  ensureCommand('unzip')
  const entries = execFileSync('unzip', ['-Z1', filePath], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const containerPath = entries.find((entry) => entry.toLowerCase() === 'meta-inf/container.xml')
  if (!containerPath) throw new Error('EPUB container.xml not found')
  const container = unzipText(filePath, containerPath)
  const opfPath = /full-path=["']([^"']+)["']/i.exec(container)?.[1]
  if (!opfPath) throw new Error('EPUB OPF path not found')
  const opf = unzipText(filePath, opfPath)
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const manifest = new Map()
  for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = item[0]
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    const media = attr(tag, 'media-type')
    if (id && href && /html|xhtml/i.test(media ?? href)) manifest.set(id, joinEpubPath(base, href))
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*>/gi)]
    .map((m) => manifest.get(m[1]))
    .filter(Boolean)
  const htmlPaths = spine.length ? spine : entries.filter((entry) => /\.x?html?$/i.test(entry)).sort()
  return htmlPaths.map((path) => ({
    title: path,
    text: htmlToText(unzipText(filePath, path)),
  })).filter((section) => section.text.trim().length > 0)
}

function makeSegments(sections) {
  const segments = []
  for (const section of sections) {
    const paragraphs = section.text
      .replace(/\r/g, '\n')
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => /[A-Za-z0-9]/.test(p))
    for (const paragraph of paragraphs) {
      const parts = paragraph.match(/[^.!?]+(?:[.!?]+["')\]]+|[.!?]+)?|[^.!?]+$/g) ?? [paragraph]
      for (const part of parts) {
        splitLong(part.trim()).forEach((text) => {
          if (text) segments.push({ section: section.title, text })
        })
      }
    }
  }
  return mergeShortSegments(segments)
}

function mergeShortSegments(segments) {
  const merged = []
  for (const segment of segments) {
    if (segment.text.length < 35 && merged.length > 0) {
      const prev = merged[merged.length - 1]
      if (prev.section === segment.section && `${prev.text} ${segment.text}`.length <= MAX_CHARS) {
        prev.text = `${prev.text} ${segment.text}`.replace(/\s+([.,!?;:])/g, '$1')
        continue
      }
    }
    merged.push({ ...segment })
  }
  return merged
}

function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text]
  let cut = text.lastIndexOf(',', MAX_CHARS)
  if (cut < MAX_CHARS / 3) cut = text.lastIndexOf(' ', MAX_CHARS)
  if (cut <= 0) cut = MAX_CHARS
  return [text.slice(0, cut).trim(), ...splitLong(text.slice(cut).trim())]
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(h[1-6]|p|div|section|article|li|blockquote|tr)>/gi, '\n\n')
    .replace(/<(h[1-6]|p|div|section|article|li|blockquote|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(x?[0-9a-f]+);/gi, (_, raw) => {
      const code = raw.toLowerCase().startsWith('x') ? parseInt(raw.slice(1), 16) : parseInt(raw, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function unzipText(filePath, entry) {
  return execFileSync('unzip', ['-p', filePath, entry], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function attr(tag, name) {
  return new RegExp(`${name}=["']([^"']+)["']`, 'i').exec(tag)?.[1] ?? null
}

function joinEpubPath(base, href) {
  const raw = `${base ? `${base}/` : ''}${href.split('#')[0]}`
  const parts = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function ensureCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
  } catch {
    throw new Error(`Required command not found: ${name}`)
  }
}

function safeBaseName(filePath) {
  return stripExt(basename(filePath)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'book'
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '')
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
