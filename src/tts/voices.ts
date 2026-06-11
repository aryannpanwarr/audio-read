export interface VoiceOption {
  id: string
  label: string
  gender: 'F' | 'M'
}

/** The highest-graded American voices in Kokoro, 3 female + 3 male. */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'af_heart', label: 'Heart', gender: 'F' },
  { id: 'af_bella', label: 'Bella', gender: 'F' },
  { id: 'af_sarah', label: 'Sarah', gender: 'F' },
  { id: 'am_fenrir', label: 'Fenrir', gender: 'M' },
  { id: 'am_michael', label: 'Michael', gender: 'M' },
  { id: 'am_puck', label: 'Puck', gender: 'M' },
]

export const DEFAULT_VOICE = 'af_heart'

export const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2]
