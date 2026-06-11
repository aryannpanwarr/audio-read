/**
 * Listening-time estimation. Starts from a ~160 wpm heuristic
 * (avg word weight ≈ 7 → 0.375 s per word → ~0.054 s per weight unit)
 * and refines with an EWMA over real synthesized durations.
 */
const DEFAULT_SEC_PER_WEIGHT = 0.054

export class TimeEstimator {
  private spw = DEFAULT_SEC_PER_WEIGHT

  /** Feed a real (weight, duration) observation; duration is at the given speed. */
  observe(weight: number, duration: number, speed: number) {
    if (weight <= 0 || duration <= 0) return
    this.spw = this.spw * 0.7 + ((duration * speed) / weight) * 0.3
  }

  seconds(weight: number, speed: number): number {
    return (weight * this.spw) / speed
  }
}

export function formatTime(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return (h ? `${h}:${mm}` : mm) + ':' + String(s).padStart(2, '0')
}
