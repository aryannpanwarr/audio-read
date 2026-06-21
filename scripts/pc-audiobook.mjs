#!/usr/bin/env node
import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KokoroTTS } from 'kokoro-js'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const DEFAULT_VOICE = 'af_heart'
const MAX_CHARS = 280
const DEFAULT_PREVIEW_TEXT = 'This is a short voice preview from Audio Read.'

const args = parseArgs(process.argv.slice(2))
if (args.worker) {
  await runWorker()
  process.exit(0)
}

if ((!args.input && !args.previewVoice) || args.help) {
  printUsage()
  process.exit(args.help ? 0 : 1)
}

const inputPath = args.input ? resolve(args.input) : null
if (inputPath && !existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`)
  process.exit(1)
}

const outDir = resolve(
  args.out ?? join(process.cwd(), 'audiobook-output', inputPath ? safeBaseName(inputPath) : 'voice-previews'),
)
mkdirSync(outDir, { recursive: true })

const voice = args.voice ?? DEFAULT_VOICE
const speed = Number(args.speed ?? '1')
const device = args.device ?? 'cpu'
const concurrency = Math.max(1, Math.min(8, Number(args.concurrency ?? '1')))
const limit = args.limit ? Math.max(1, Number(args.limit)) : null

if (inputPath) console.log(`Input: ${inputPath}`)
console.log(`Output: ${outDir}`)
console.log(`Voice: ${voice}`)
console.log(`Speed: ${speed}`)
console.log(`Device: ${device}`)
if (!args.previewVoice) console.log(`Workers: ${concurrency}`)

if (args.previewVoice) {
  console.log('Loading Kokoro...')
  const tts = await loadKokoro(args.dtype, device)
  const previewText = args.previewText ?? DEFAULT_PREVIEW_TEXT
  const previewPath = join(outDir, `voice-preview-${safeName(voice)}.wav`)
  console.log(`Preview text: ${previewText}`)
  const started = performance.now()
  const audio = await tts.generate(previewText, { voice, speed })
  await audio.save(previewPath)
  const duration = audio.audio.length / audio.sampling_rate
  const elapsed = (performance.now() - started) / 1000
  const manifest = {
    version: 1,
    type: 'voice-preview',
    model: MODEL_ID,
    voice,
    speed,
    text: previewText,
    audio: basename(previewPath),
    duration: round(duration),
    sampleRate: audio.sampling_rate,
    samples: audio.audio.length,
    generationSeconds: round(elapsed),
    generatedAt: new Date().toISOString(),
  }
  writeFileSync(join(outDir, `voice-preview-${safeName(voice)}.json`), JSON.stringify(manifest, null, 2))
  console.log(`Preview: ${previewPath}`)
  process.exit(0)
}

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

if (concurrency === 1) {
  console.log('Loading Kokoro...')
  const tts = await loadKokoro(args.dtype, device)
  for (let i = 0; i < segments.length; i++) {
    const result = await generateSegment(tts, segments[i], i, segments.length, outDir, voice, speed)
    manifest.segments.push(result)
    writeOrderedManifest(manifest, outDir, segments)
  }
} else {
  await generateParallel(segments, manifest, outDir, {
    voice,
    speed,
    dtype: args.dtype,
    device,
    concurrency,
  })
}

writeOrderedManifest(manifest, outDir, segments)
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
    else if (arg === '--device') out.device = argv[++i]
    else if (arg === '--concurrency' || arg === '--workers') out.concurrency = argv[++i]
    else if (arg === '--limit') out.limit = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--worker') out.worker = true
    else if (arg === '--preview-voice') out.previewVoice = true
    else if (arg === '--preview-text') out.previewText = argv[++i]
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
  --device      cpu or cuda; default cpu
  --concurrency Number of Kokoro worker processes; default 1
  --limit       Generate only first N segments for a quick sample
  --dry-run     Extract/segment only; do not load Kokoro or generate audio
  --preview-voice Generate one short WAV sample for the selected voice
  --preview-text  Text to use with --preview-voice`)
}

async function loadKokoro(dtype, device) {
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: dtype ?? 'q8',
    device: device ?? 'cpu',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100)
        process.stdout.write(`\rDownloading ${p.file ?? ''} ${pct}%`)
      }
    },
  })
  process.stdout.write('\n')
  return tts
}

async function generateSegment(tts, segment, index, total, outputDir, voiceName, voiceSpeed) {
  const name = `${String(index + 1).padStart(4, '0')}.wav`
  const audioPath = join(outputDir, name)
  const label = `${index + 1}/${total}`
  console.log(`[${label}] ${segment.text.slice(0, 80).replace(/\s+/g, ' ')}${segment.text.length > 80 ? '...' : ''}`)
  const started = performance.now()
  const audio = await tts.generate(segment.text, { voice: voiceName, speed: voiceSpeed })
  await audio.save(audioPath)
  const duration = audio.audio.length / audio.sampling_rate
  const elapsed = (performance.now() - started) / 1000
  return {
    index,
    section: segment.section,
    audio: name,
    text: segment.text,
    duration: round(duration),
    sampleRate: audio.sampling_rate,
    samples: audio.audio.length,
    generationSeconds: round(elapsed),
  }
}

async function generateParallel(segmentsToGenerate, manifest, outputDir, options) {
  const workerCount = Math.min(options.concurrency, segmentsToGenerate.length)
  console.log(`Starting ${workerCount} Kokoro workers...`)
  const workers = []
  let nextIndex = 0
  let completed = 0
  const closingWorkers = new WeakSet()

  await new Promise((resolvePromise, rejectPromise) => {
    const fail = error => {
      workers.forEach(worker => worker.kill())
      rejectPromise(error)
    }

    const assign = worker => {
      if (nextIndex >= segmentsToGenerate.length) {
        closingWorkers.add(worker)
        worker.send({ type: 'close' })
        return
      }
      const index = nextIndex++
      worker.send({ type: 'segment', index, total: segmentsToGenerate.length, segment: segmentsToGenerate[index] })
    }

    for (let id = 0; id < workerCount; id++) {
      const worker = fork(fileURLToPath(import.meta.url), ['--worker'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      workers.push(worker)
      worker.on('message', message => {
        if (message.type === 'ready') {
          assign(worker)
        } else if (message.type === 'done') {
          completed += 1
          manifest.segments.push(message.result)
          writeOrderedManifest(manifest, outputDir, segmentsToGenerate)
          console.log(
            `[done ${completed}/${segmentsToGenerate.length}] ${String(message.result.index + 1).padStart(4, '0')} ` +
              `${message.result.duration}s audio in ${message.result.generationSeconds}s`,
          )
          assign(worker)
          if (completed >= segmentsToGenerate.length) resolvePromise()
        } else if (message.type === 'error') {
          fail(new Error(message.error))
        }
      })
      worker.on('error', fail)
      worker.on('exit', code => {
        if (!closingWorkers.has(worker) && completed < segmentsToGenerate.length) {
          fail(new Error(`Worker exited with code ${code}`))
        }
      })
      worker.send({
        type: 'init',
        outputDir,
        voice: options.voice,
        speed: options.speed,
        dtype: options.dtype,
        device: options.device,
      })
    }
  })
}

async function runWorker() {
  let tts = null
  let config = null
  return new Promise(resolvePromise => {
    process.on('message', async message => {
      try {
        if (message.type === 'init') {
          config = message
          tts = await loadKokoro(config.dtype, config.device)
          process.send?.({ type: 'ready' })
        } else if (message.type === 'segment') {
          if (!tts || !config) throw new Error('Worker not initialized')
          const result = await generateSegment(
            tts,
            message.segment,
            message.index,
            message.total,
            config.outputDir,
            config.voice,
            config.speed,
          )
          process.send?.({ type: 'done', result })
        } else if (message.type === 'close') {
          resolvePromise()
        }
      } catch (error) {
        process.send?.({ type: 'error', error: error instanceof Error ? error.stack ?? error.message : String(error) })
      }
    })
  })
}

function writeOrderedManifest(manifest, outputDir, sourceSegments) {
  const generated = [...manifest.segments].sort((a, b) => a.index - b.index)
  let cursor = 0
  manifest.segments = generated.map(segment => {
    const start = cursor
    cursor += segment.duration
    return {
      ...segment,
      text: sourceSegments[segment.index]?.text ?? segment.text,
      start: round(start),
      end: round(cursor),
    }
  })
  manifest.generatedSegments = manifest.segments.length
  manifest.totalSegments = sourceSegments.length
  manifest.duration = round(cursor)
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
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
  return safeName(stripExt(basename(filePath))) || 'book'
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '')
}

function round(value) {
  return Math.round(value * 1000) / 1000
}
