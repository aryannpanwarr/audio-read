import { formatTime } from '../lib/estimate'
import { SPEED_OPTIONS, VOICE_OPTIONS } from '../tts/voices'
import { hasDeviceTts } from '../tts/deviceTts'
import type { Engine, ModelStatus, Phase } from '../hooks/useReader'

interface Props {
  phase: Phase
  engine: Engine
  modelStatus: ModelStatus
  voice: string
  deviceVoices: SpeechSynthesisVoice[]
  deviceVoiceUri: string
  speed: number
  times: { total: number; remaining: number }
  onPlay: () => void
  onPause: () => void
  onEngine: (e: Engine) => void
  onVoice: (v: string) => void
  onDeviceVoice: (uri: string) => void
  onSpeed: (v: number) => void
}

export function Controls({
  phase,
  engine,
  modelStatus,
  voice,
  deviceVoices,
  deviceVoiceUri,
  speed,
  times,
  onPlay,
  onPause,
  onEngine,
  onVoice,
  onDeviceVoice,
  onSpeed,
}: Props) {
  const playing = phase === 'playing' || phase === 'buffering'
  const canPlay = engine === 'device' || modelStatus === 'ready'

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

      {hasDeviceTts() && (
        <label className="control-field">
          <span>Engine</span>
          <select value={engine} onChange={(e) => onEngine(e.target.value as Engine)}>
            <option value="kokoro">AI (Kokoro)</option>
            <option value="device">Device</option>
          </select>
        </label>
      )}

      <label className="control-field">
        <span>Voice</span>
        {engine === 'kokoro' ? (
          <select value={voice} onChange={(e) => onVoice(e.target.value)}>
            {VOICE_OPTIONS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} ({v.gender})
              </option>
            ))}
          </select>
        ) : (
          <select value={deviceVoiceUri} onChange={(e) => onDeviceVoice(e.target.value)}>
            {deviceVoices.length === 0 && <option value="">System default</option>}
            {deviceVoices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}
              </option>
            ))}
          </select>
        )}
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
