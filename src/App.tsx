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
        {reader.device && <span className="device-badge">{reader.device}</span>}
        <button className="reset-btn" onClick={reader.reset}>
          Open another PDF
        </button>
      </header>

      {reader.modelStatus === 'loading' && (
        <ModelLoadingBar loaded={reader.modelProgress.loaded} total={reader.modelProgress.total} />
      )}
      {reader.error && <p className="error banner">{reader.error}</p>}

      <ReaderView
        sentences={reader.sentences}
        highlight={reader.highlight}
        current={reader.current}
        isPlaying={reader.phase === 'playing'}
        onWordClick={reader.jumpTo}
      />

      <Controls
        phase={reader.phase}
        modelStatus={reader.modelStatus}
        voice={reader.voice}
        speed={reader.speed}
        times={reader.times}
        onPlay={reader.play}
        onPause={reader.pause}
        onVoice={reader.setVoice}
        onSpeed={reader.setSpeed}
      />
    </div>
  )
}
