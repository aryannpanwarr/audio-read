const api = window.audioReadDesktop

const els = {
  input: document.getElementById('inputPath'),
  output: document.getElementById('outputPath'),
  chooseInput: document.getElementById('chooseInput'),
  chooseOutput: document.getElementById('chooseOutput'),
  openOutput: document.getElementById('openOutput'),
  voice: document.getElementById('voice'),
  previewVoice: document.getElementById('previewVoice'),
  previewText: document.getElementById('previewText'),
  speed: document.getElementById('speed'),
  dtype: document.getElementById('dtype'),
  limit: document.getElementById('limit'),
  dryRun: document.getElementById('dryRun'),
  start: document.getElementById('start'),
  cancel: document.getElementById('cancel'),
  state: document.getElementById('state'),
  detail: document.getElementById('detail'),
  progress: document.getElementById('progressFill'),
  log: document.getElementById('log'),
  clearLog: document.getElementById('clearLog'),
}

let running = false
let lastOutput = ''

els.chooseInput.addEventListener('click', async () => {
  const path = await api.selectInput()
  if (path) els.input.value = path
})

els.chooseOutput.addEventListener('click', async () => {
  const path = await api.selectOutput()
  if (path) els.output.value = path
})

els.openOutput.addEventListener('click', () => {
  if (lastOutput) void api.openPath(lastOutput)
})

els.clearLog.addEventListener('click', () => {
  els.log.textContent = ''
})

els.start.addEventListener('click', async () => {
  if (running) return
  const options = {
    input: els.input.value,
    output: els.output.value,
    voice: els.voice.value,
    speed: els.speed.value,
    dtype: els.dtype.value,
    limit: els.limit.value,
    dryRun: els.dryRun.checked,
  }
  setRunning(true)
  setState('Starting', 'Launching generator...')
  els.log.textContent = ''
  try {
    await api.startGeneration(options)
  } catch (error) {
    appendLog(`${error?.message ?? error}\n`)
    setState('Error', String(error?.message ?? error))
    setRunning(false)
  }
})

els.previewVoice.addEventListener('click', async () => {
  if (running) return
  const options = {
    output: els.output.value,
    voice: els.voice.value,
    speed: els.speed.value,
    dtype: els.dtype.value,
    previewText: els.previewText.value,
  }
  setRunning(true)
  setState('Previewing', `Generating ${els.voice.value} sample...`)
  els.log.textContent = ''
  try {
    await api.previewVoice(options)
  } catch (error) {
    appendLog(`${error?.message ?? error}\n`)
    setState('Error', String(error?.message ?? error))
    setRunning(false)
  }
})

els.cancel.addEventListener('click', async () => {
  await api.cancelGeneration()
  setState('Cancelled', 'Generation stopped.')
  setRunning(false)
})

api.onStarted(payload => {
  lastOutput = payload.output
  els.openOutput.disabled = false
  setState('Running', payload.output)
  appendLog(`Command: ${payload.command}\n\n`)
})

api.onLog(chunk => {
  appendLog(chunk)
  updateProgressFromLog(chunk)
})

api.onDone(payload => {
  lastOutput = payload.output
  els.openOutput.disabled = false
  setState(payload.ok ? 'Done' : 'Failed', payload.ok ? payload.output : `Exited with code ${payload.code}`)
  els.progress.style.width = payload.ok ? '100%' : els.progress.style.width
  setRunning(false)
})

function setRunning(next) {
  running = next
  els.start.disabled = next
  els.cancel.disabled = !next
  els.chooseInput.disabled = next
  els.chooseOutput.disabled = next
  els.previewVoice.disabled = next
}

function setState(state, detail) {
  els.state.textContent = state
  els.detail.textContent = detail
}

function appendLog(text) {
  els.log.textContent += text
  els.log.scrollTop = els.log.scrollHeight
}

function updateProgressFromLog(text) {
  const segment = /\[(\d+)\/(\d+)\]/g
  let match
  while ((match = segment.exec(text))) {
    const done = Number(match[1]) - 1
    const total = Number(match[2])
    if (total > 0) els.progress.style.width = `${Math.max(0, Math.min(100, Math.round((done / total) * 100)))}%`
  }
  const download = /Downloading .*? (\d+)%/g
  while ((match = download.exec(text))) {
    els.progress.style.width = `${Number(match[1])}%`
  }
}
