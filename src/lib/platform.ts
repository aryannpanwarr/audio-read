export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.maxTouchPoints > 1 && /Mobile|Tablet/i.test(navigator.userAgent)
}
