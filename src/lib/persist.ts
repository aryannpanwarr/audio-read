/** Reading-position and preference persistence (localStorage). */

const POS_KEY = 'audio-read-positions'
const PREFS_KEY = 'audio-read-prefs'
const MAX_DOCS = 30

/** Stable id for a document: content hash of the first 64KB + size. */
export async function docKey(file: File): Promise<string> {
  try {
    // crypto.subtle is unavailable on insecure origins (e.g. LAN http)
    const head = await file.slice(0, 65536).arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', head)
    const hex = [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `${hex}-${file.size}`
  } catch {
    return `${file.name}-${file.size}-${file.lastModified}`
  }
}

interface PositionEntry {
  sentence: number
  savedAt: number
}

function readPositions(): Record<string, PositionEntry> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Record<string, PositionEntry>
  } catch {
    return {}
  }
}

export function loadPosition(key: string): number | null {
  const entry = readPositions()[key]
  return typeof entry?.sentence === 'number' ? entry.sentence : null
}

export function savePosition(key: string, sentence: number) {
  try {
    const all = readPositions()
    all[key] = { sentence, savedAt: Date.now() }
    const recent = Object.entries(all)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_DOCS)
    localStorage.setItem(POS_KEY, JSON.stringify(Object.fromEntries(recent)))
  } catch {
    // storage full or blocked — losing the bookmark is non-fatal
  }
}

export interface Prefs {
  voice?: string
  speed?: number
  deviceVoice?: string
}

export function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs
  } catch {
    return {}
  }
}

export function savePrefs(patch: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {
    // non-fatal
  }
}
