interface Props {
  loaded: number
  total: number
}

export function ModelLoadingBar({ loaded, total }: Props) {
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
  return (
    <div className="model-loading">
      <div className="model-loading-label">
        Downloading voices (one-time) — {total > 0 ? `${mb(loaded)} / ${mb(total)} MB` : 'starting…'}
      </div>
      <div className="model-loading-track">
        <div className="model-loading-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
