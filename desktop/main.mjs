import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KokoroTTS } from 'kokoro-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')
const generatorPath = join(rootDir, 'scripts', 'pc-audiobook.mjs')
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let win
let currentProcess = null
let currentTask = null
const previewModels = new Map()

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#101312',
    title: 'Audio Read Audiobook Generator',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(join(__dirname, 'renderer.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

ipcMain.handle('select-input', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a book',
    properties: ['openFile'],
    filters: [
      { name: 'Books', extensions: ['epub', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('select-output', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('open-path', async (_event, targetPath) => {
  if (!targetPath || !existsSync(targetPath)) return false
  await shell.openPath(targetPath)
  return true
})

ipcMain.handle('start-generation', async (event, options) => {
  if (currentProcess) throw new Error('Generation is already running')
  const input = options?.input
  if (!input || !existsSync(input)) throw new Error('Choose a valid EPUB or TXT file')
  const output = options?.output || join(rootDir, 'audiobook-output', safeBaseName(input))
  mkdirSync(output, { recursive: true })

  const args = [generatorPath, '--input', input, '--out', output]
  if (options.voice) args.push('--voice', options.voice)
  if (options.speed) args.push('--speed', String(options.speed))
  if (options.dtype) args.push('--dtype', options.dtype)
  if (options.device) args.push('--device', options.device)
  if (options.concurrency) args.push('--concurrency', String(options.concurrency))
  if (options.limit) args.push('--limit', String(options.limit))
  if (options.dryRun) args.push('--dry-run')

  currentProcess = spawn(nodeExecutable(), args, {
    cwd: rootDir,
    env: process.env,
  })
  currentTask = 'generation'

  const send = (channel, payload) => event.sender.send(channel, payload)
  send('generation-started', { output, command: `${nodeExecutable()} ${args.map(quoteArg).join(' ')}` })

  currentProcess.stdout.on('data', data => send('generation-log', data.toString()))
  currentProcess.stderr.on('data', data => send('generation-log', data.toString()))
  currentProcess.on('error', error => {
    send('generation-done', { ok: false, code: null, output, error: error.message })
    currentProcess = null
    currentTask = null
  })
  currentProcess.on('close', code => {
    send('generation-done', { ok: code === 0, code, output })
    currentProcess = null
    currentTask = null
  })
  return { output }
})

ipcMain.handle('preview-voice', async (event, options) => {
  if (currentProcess || currentTask) throw new Error('Generation is already running')
  const output = options?.output || join(rootDir, 'audiobook-output', 'voice-previews')
  mkdirSync(output, { recursive: true })

  const voice = options?.voice || 'af_heart'
  const dtype = options?.dtype || 'q8'
  const device = options?.device || 'cpu'
  const speed = Number(options?.speed || 1)
  const previewText = options?.previewText || 'This is a short voice preview from Audio Read.'
  const previewPath = join(output, `voice-preview-${safeName(voice)}.wav`)
  const send = (channel, payload) => event.sender.send(channel, payload)
  currentTask = 'preview'
  send('generation-started', { output, command: `preview ${voice} ${dtype} ${device}` })
  try {
    send('generation-log', `Output: ${output}\nVoice: ${voice}\nSpeed: ${speed}\nDevice: ${device}\n`)
    const modelKey = `${device}:${dtype}`
    send('generation-log', previewModels.has(modelKey) ? 'Using loaded Kokoro model.\n' : 'Loading Kokoro model for preview...\n')
    const model = await previewModel(dtype, device, message => send('generation-log', message))
    send('generation-log', `Preview text: ${previewText}\n`)
    const started = performance.now()
    const audio = await model.generate(previewText, { voice, speed })
    await audio.save(previewPath)
    const elapsed = Math.round((performance.now() - started) / 10) / 100
    send('generation-log', `Preview generated in ${elapsed}s: ${previewPath}\n`)
    send('generation-done', {
      ok: true,
      code: 0,
      output,
      previewPath,
      previewUrl: pathToFileURL(previewPath).toString(),
    })
  } catch (error) {
    send('generation-log', `${error instanceof Error ? error.message : String(error)}\n`)
    send('generation-done', { ok: false, code: null, output, error: error instanceof Error ? error.message : String(error) })
  } finally {
    currentTask = null
  }
  return { output, previewPath }
})

ipcMain.handle('cancel-generation', async () => {
  if (!currentProcess) return false
  currentProcess.kill('SIGTERM')
  currentProcess = null
  currentTask = null
  return true
})

async function previewModel(dtype, device, log) {
  const key = `${device}:${dtype}`
  if (previewModels.has(key)) return previewModels.get(key)
  const model = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: progress => {
      if (progress.status === 'progress' && progress.total) {
        const percent = Math.round((progress.loaded / progress.total) * 100)
        log(`Downloading ${progress.file ?? ''} ${percent}%\n`)
      }
    },
  })
  previewModels.set(key, model)
  return model
}

function nodeExecutable() {
  return process.env.npm_node_execpath || process.env.NODE || 'node'
}

function safeBaseName(filePath) {
  return safeName(basename(filePath).replace(/\.[^.]+$/, '')) || 'book'
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function quoteArg(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value
}
