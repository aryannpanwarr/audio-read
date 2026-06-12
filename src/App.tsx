import { useReader } from './hooks/useReader'
import { UploadScreen } from './components/UploadScreen'
import { ModelLoadingBar } from './components/ModelLoadingBar'
import { ReaderView } from './components/ReaderView'
import { Controls } from './components/Controls'

export default function App() {
  const reader = useReader()
  const hasDocument = reader.sentences.length > 0

  if (!hasDocument) {
    return (
      <UploadScreen
        busy={reader.phase === 'extracting'}
        error={reader.error}
        onFile={reader.loadDocument}
      />
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🔊 Audio Read</span>
        {reader.engine === 'device' ? (
          <span className="device-badge">device voices</span>
        ) : (
          reader.device && <span className="device-badge">{reader.device}</span>
        )}
        <button className="reset-btn" onClick={reader.reset}>
          Open another PDF
        </button>
      </header>

      {reader.engine === 'kokoro' && reader.modelStatus === 'loading' && (
        <ModelLoadingBar loaded={reader.modelProgress.loaded} total={reader.modelProgress.total} />
      )}
      {reader.error && (
        <p className="error banner">
          {reader.error}
          {reader.engine === 'kokoro' && reader.modelStatus === 'idle' && (
            <>
              {' '}
              <button className="retry-btn" onClick={reader.retryModel}>
                Retry
              </button>{' '}
              <button className="retry-btn" onClick={() => reader.setEngine('device')}>
                Use device voices instead
              </button>
            </>
          )}
        </p>
      )}

      {reader.hint && (
        <p className="hint banner">
          {reader.hint}{' '}
          <button className="retry-btn" onClick={() => reader.setEngine('device')}>
            Switch to device voices
          </button>{' '}
          <button className="retry-btn" onClick={reader.dismissHint}>
            Dismiss
          </button>
        </p>
      )}

      <ReaderView
        sentences={reader.sentences}
        highlight={reader.highlight}
        current={reader.current}
        isPlaying={reader.phase === 'playing'}
        onWordClick={reader.jumpTo}
      />

      <Controls
        phase={reader.phase}
        engine={reader.engine}
        modelStatus={reader.modelStatus}
        voice={reader.voice}
        deviceVoices={reader.deviceVoices}
        deviceVoiceUri={reader.deviceVoiceUri}
        speed={reader.speed}
        perf={reader.perf}
        times={reader.times}
        onPlay={reader.play}
        onPause={reader.pause}
        onEngine={reader.setEngine}
        onVoice={reader.setVoice}
        onDeviceVoice={reader.setDeviceVoiceUri}
        onSpeed={reader.setSpeed}
        onPerf={reader.setPerf}
      />
    </div>
  )
}
