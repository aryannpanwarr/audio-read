import { useRef, useState, type DragEvent } from 'react'

interface Props {
  busy: boolean
  error: string | null
  onFile: (file: File) => void
}

export function UploadScreen({ busy, error, onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  return (
    <div className="upload-screen">
      <h1>🔊 Audio Read</h1>
      <p className="tagline">Upload a PDF and listen to it. Everything runs locally in your browser.</p>
      <div
        className={'dropzone' + (dragOver ? ' drag-over' : '')}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {busy ? (
          <span>Reading your PDF…</span>
        ) : (
          <span>
            <strong>Drop a PDF here</strong> or click to browse
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
