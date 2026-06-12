import { formatTime } from '../lib/estimate'
import { SPEED_OPTIONS, VOICE_OPTIONS } from '../tts/voices'
import { hasDeviceTts } from '../tts/deviceTts'
import { PERF_OPTIONS, type Perf } from '../tts/ttsClient'
import type { Engine, ModelStatus, Phase } from '../hooks/useReader'

interface Props {
  phase: Phase
  engine: Engine
  modelStatus: ModelStatus
  voice: string
  deviceVoices: SpeechSynthesisVoice[]
  deviceVoiceUri: string
  speed: number
  perf: Perf
  times: { total: number; remaining: number }
  onPlay: () => void
  onPause: () => void
  onEngine: (e: Engine) => void
  onVoice: (v: string) => void
  onDeviceVoice: (uri: string) => void
  onSpeed: (v: number) => void
  onPerf: (p: Perf) => void
}

export function Controls({
  phase,
  engine,
  modelStatus,
  voice,
  deviceVoices,
  deviceVoiceUri,
  speed,
  perf,
  times,
  onPlay,
  onPause,
  onEngine,
  onVoice,
  onDeviceVoice,
  onSpeed,
  onPerf,
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

      {engine === 'kokoro' && (
        <label
          className="control-field"
          title="If playback stutters, try another preset — changing it reloads the model"
        >
          <span>Performance</span>
          <select value={perf} onChange={(e) => onPerf(e.target.value as Perf)}>
            {PERF_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="time-display" title="Estimated from reading speed">
        <strong>{formatTime(times.remaining)}</strong> left&nbsp;·&nbsp;≈{formatTime(times.total)} total
      </div>
    </div>
  )
}
