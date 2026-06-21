import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')
const generatorPath = join(rootDir, 'scripts', 'pc-audiobook.mjs')

let win
let currentProcess = null

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
  if (options.limit) args.push('--limit', String(options.limit))
  if (options.dryRun) args.push('--dry-run')

  currentProcess = spawn(process.execPath, args, {
    cwd: rootDir,
    env: process.env,
  })

  const send = (channel, payload) => event.sender.send(channel, payload)
  send('generation-started', { output, command: `${process.execPath} ${args.map(quoteArg).join(' ')}` })

  currentProcess.stdout.on('data', data => send('generation-log', data.toString()))
  currentProcess.stderr.on('data', data => send('generation-log', data.toString()))
  currentProcess.on('error', error => {
    send('generation-done', { ok: false, code: null, output, error: error.message })
    currentProcess = null
  })
  currentProcess.on('close', code => {
    send('generation-done', { ok: code === 0, code, output })
    currentProcess = null
  })
  return { output }
})

ipcMain.handle('preview-voice', async (event, options) => {
  if (currentProcess) throw new Error('Generation is already running')
  const output = options?.output || join(rootDir, 'audiobook-output', 'voice-previews')
  mkdirSync(output, { recursive: true })

  const voice = options?.voice || 'af_heart'
  const args = [generatorPath, '--preview-voice', '--out', output, '--voice', voice]
  if (options.speed) args.push('--speed', String(options.speed))
  if (options.dtype) args.push('--dtype', options.dtype)
  if (options.previewText) args.push('--preview-text', options.previewText)

  currentProcess = spawn(process.execPath, args, {
    cwd: rootDir,
    env: process.env,
  })

  const previewPath = join(output, `voice-preview-${safeName(voice)}.wav`)
  const send = (channel, payload) => event.sender.send(channel, payload)
  send('generation-started', { output, command: `${process.execPath} ${args.map(quoteArg).join(' ')}` })

  currentProcess.stdout.on('data', data => send('generation-log', data.toString()))
  currentProcess.stderr.on('data', data => send('generation-log', data.toString()))
  currentProcess.on('error', error => {
    send('generation-done', { ok: false, code: null, output, error: error.message })
    currentProcess = null
  })
  currentProcess.on('close', async code => {
    if (code === 0 && existsSync(previewPath)) await shell.openPath(previewPath)
    send('generation-done', { ok: code === 0, code, output, previewPath })
    currentProcess = null
  })
  return { output, previewPath }
})

ipcMain.handle('cancel-generation', async () => {
  if (!currentProcess) return false
  currentProcess.kill('SIGTERM')
  currentProcess = null
  return true
})

function safeBaseName(filePath) {
  return safeName(basename(filePath).replace(/\.[^.]+$/, '')) || 'book'
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function quoteArg(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value
}
