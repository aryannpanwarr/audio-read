import { formatTime } from '../lib/estimate'
import { SPEED_OPTIONS, VOICE_OPTIONS } from '../tts/voices'
import type { ModelStatus, Phase } from '../hooks/useReader'

interface Props {
  phase: Phase
  modelStatus: ModelStatus
  voice: string
  speed: number
  times: { total: number; remaining: number }
  onPlay: () => void
  onPause: () => void
  onVoice: (v: string) => void
  onSpeed: (v: number) => void
}

export function Controls({ phase, modelStatus, voice, speed, times, onPlay, onPause, onVoice, onSpeed }: Props) {
  const playing = phase === 'playing' || phase === 'buffering'
  const canPlay = modelStatus === 'ready'

  return (
    <div className="controls">
      <button
        className="play-btn"
        disabled={!canPlay}
        onClick={playing ? onPause : onPlay}
        title={canPlay ? '' : 'Voices are still downloading'}
      >
        {phase === 'buffering' ? '…' : playing ? '⏸' : '▶'}
      </button>

      <label className="control-field">
        <span>Voice</span>
        <select value={voice} onChange={(e) => onVoice(e.target.value)}>
          {VOICE_OPTIONS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} ({v.gender})
            </option>
          ))}
        </select>
      </label>

      <label className="control-field">
        <span>Speed</span>
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>

      <div className="time-display" title="Estimated from reading speed">
        <strong>{formatTime(times.remaining)}</strong> left&nbsp;·&nbsp;≈{formatTime(times.total)} total
      </div>
    </div>
  )
}
